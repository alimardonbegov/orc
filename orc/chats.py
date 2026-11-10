"""Direct chats with an agent: one Claude Code session per chat, one background turn per message batch.

A chat is deliberately not a task: it has no board status, verification or merge. It shares the session
contract with tasks (`claude --bg`, state.json, the transcript) because that contract survives a server
restart and gives the same model, effort and permission behavior. Mechanics worth knowing:

- Isolation. A project chat works in its own worktree (`orc-chat-<id>` on branch `orc/chat-<id>`), never
  in the owner's working copy, and nothing from it is merged. A chat outside a project gets an empty
  folder of its own under the data directory.
- One session per chat, shut down after each turn. An idle `claude` process costs hundreds of megabytes,
  and waking a stopped session reuses its saved options. Chat jobs are not in `task_sessions`, so
  the task session reaper never sees them; this module is their only owner.
- The transcript is the source of replies, read from a stored byte offset, so a server restart in the
  middle of a turn loses nothing and repeats nothing. state.json only says when the turn is over.
- Messages sent during a turn queue up and go together as the next turn.
- A lead's chat gets the board as context and may propose tasks, which only the owner can accept:
  a coordinator that cannot create work by itself cannot run away with the limits. Proposals travel as
  a marked block in the reply text rather than as a file, so they need no tool permission and work in
  every permission mode, including a read-only lead. Any other chat is told about `orc task` instead,
  because there the owner is asking the agent directly.

See docs/internals/agents.md.
"""
from __future__ import annotations

import json
import logging
import re
import secrets
import shutil
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from orc import agents, branches, git_ops, inputs, task_guide, task_plans, token_usage, trust, usage
from orc.claude_cli import JobState
from orc.config import Settings
from orc.db import ledger_cost
from orc.models import Agent, Chat, Project, TaskStatus
from orc.prompt import UNTRUSTED_NOTE, quote_untrusted_list
from orc.repo import Repo
from orc.sessions import RESUMABLE_STATES, STOP_TERMINAL_STATES, SessionRunner
from orc.transcript import _timestamp
from orc.util import utc_now

log = logging.getLogger("orc.chats")

# Right after a launch state.json may still describe the previous turn ("stopped", "idle"). Until the
# transcript moves, such a state ends the turn only after this long.
TURN_START_GRACE_SEC = 30
# The transcript of a resumed copy repeats the old conversation: lines older than the turn are history.
HISTORY_TOLERANCE_SEC = 2
# A permission, a question or a plan the session waits on is a message of this role, so it sits in the
# conversation where the owner is reading. States: open | answered | cancelled.
INPUT_REQUEST_ROLE = "input_request"
# The daemon rewrites tempo/needs with a delay after the hook was answered: without the pause the chat
# would say "waiting for approval" again right after the owner approved.
INPUT_ANSWER_GRACE_SEC = 60
ACTIVE_POLL_SEC = 1.5
IDLE_POLL_SEC = 10
TITLE_CHARS = 60
TOOL_DETAIL_CHARS = 140
# Which tool input says the most about the call, in order of preference
TOOL_DETAIL_KEYS = ("file_path", "path", "command", "pattern", "description", "url", "query", "prompt")
PROPOSALS_FENCE = "orc-tasks"
PROPOSALS_RE = re.compile(rf"```{PROPOSALS_FENCE}[ \t]*\n(.*?)```", re.DOTALL)
PROPOSALS_MAX = 10
BOARD_STATUSES = (TaskStatus.BACKLOG, TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.VERIFYING,
                  TaskStatus.MERGING, TaskStatus.FAILED)


class ChatError(RuntimeError):
    """The owner can act on this: the text goes into the conversation as it is."""


def worktree_path(project: Project, chat_id: int) -> Path:
    return Path(project.path) / ".claude" / "worktrees" / f"orc-chat-{chat_id}"


def chat_system_prompt(agent: Agent, project: Project | None, is_lead: bool, chat: Chat, data_dir: Path) -> str:
    """The agent's persona plus what a session has to know to behave in a chat rather than in a task."""
    parts = [agents.system_prompt(agent) or "", "",
             "You are in a direct chat with the owner of this machine, through the orc dashboard. "
             "Answer in plain text in the owner's language. The owner reads only your text replies: "
             "do not use interactive question or plan-approval tools, ask in plain text instead."]
    if project is None:
        parts.append("This chat is not attached to any repository; your folder is an empty scratch space.")
    else:
        parts.append(f"You are working on the project \"{project.name}\". The current folder is a private copy of "
                     f"its repository on branch {chat.branch}. Read anything you need. Changes made here never "
                     f"reach the project on their own: nothing from this branch is merged.")
    if is_lead:
        parts += ["", f"You are the lead of this project: you plan and delegate rather than implement. "
                      f"To delegate, put a fenced code block with the info string {PROPOSALS_FENCE} into your reply, "
                      f"holding a JSON array with one object per task: "
                      f'{{"title": "...", "description": "the complete assignment for the executor", '
                      f'"agent": "name of a team member or null", "ref": "optional short name", '
                      f'"depends_on": ["refs from this block or numbers of tasks on the board"]}}. '
                      f"Steps of one feature that build on each other go in one block, linked by depends_on: each "
                      f"waits for the previous one to be merged, on the same base branch, and each executor sees "
                      f"only its description and what has been merged. The owner sees each one as a card in this chat "
                      f"and decides whether it goes to the backlog. You cannot start tasks yourself, and the "
                      f"block is the only way to propose them: do not write them to files. "
                      f"Each of your messages arrives with the current board and team.", "", UNTRUSTED_NOTE]
    else:
        parts += ["", task_guide.session_note(data_dir)]
    return "\n".join(parts)


def board_context(repo: Repo, project: Project, agent: Agent) -> str:
    """What a lead needs at the start of every turn. Task titles were typed by people and agents, so
    they are marked as data."""
    tasks = [t for t in repo.list_tasks(project.id) if t.status in BOARD_STATUSES]
    team = [a for a in repo.list_agents(project.id) if a.id != agent.id]
    return ("<orc-context>\nThe board of the project right now (not part of the owner's message):\n"
            + quote_untrusted_list([f"#{t.id} [{t.status}] {t.title}" for t in tasks], empty="no open tasks")
            + "\nThe team you can delegate to:\n"
            + quote_untrusted_list([f"{a.name}: {a.description}" for a in team], empty="nobody: leave agent null")
            + "\n</orc-context>\n\n")


def _tool_line(name: str, tool_input: object) -> str:
    detail = ""
    if isinstance(tool_input, dict):
        for key in TOOL_DETAIL_KEYS:
            value = tool_input.get(key)
            if isinstance(value, str) and value.strip():
                detail = " ".join(value.split())[:TOOL_DETAIL_CHARS]
                break
    return f"{name} {detail}".strip()


def parse_turn_lines(lines: list[str], since: float | None) -> list[tuple[str, str]]:
    """Transcript lines → (role, body): the agent's text and a line per tool call.

    Subagents write to their own files, and their lines marked `isSidechain` are skipped too: the owner
    is talking to the agent, not to whoever it delegated to.
    """
    out: list[tuple[str, str]] = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("type") != "assistant" or entry.get("isSidechain"):
            continue
        at = _timestamp(entry.get("timestamp"))
        if since is not None and at is not None and at < since - HISTORY_TOLERANCE_SEC:
            continue
        content = (entry.get("message") or {}).get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and str(block.get("text") or "").strip():
                out.append(("assistant", str(block["text"]).strip()))
            elif block.get("type") == "tool_use":
                out.append(("activity", _tool_line(str(block.get("name") or "tool"), block.get("input"))))
    return out


def split_proposals(text: str) -> tuple[str, list[dict], str | None]:
    """A lead's reply → the text for the owner, the proposed tasks and a complaint if a block is broken.

    A broken block stays in the text: the owner should see what the lead tried to say.
    """
    items: list[dict] = []
    error: str | None = None

    def take(match: re.Match) -> str:
        nonlocal error
        try:
            parsed = json.loads(match.group(1))
            if not isinstance(parsed, list):
                raise ValueError("expected a JSON array")
        except ValueError as e:
            error = f"could not read the proposed tasks: {e}"
            return match.group(0)
        items.extend(parsed)
        return ""

    return PROPOSALS_RE.sub(take, text).strip(), items, error


class ChatRunner:
    """The chat loop: starts queued turns and carries running ones to their end. Thread-safe: the loop
    thread and API commands (stop, delete) take turns on one lock."""

    def __init__(self, repo: Repo, cli, settings: Settings, now: Callable[[], datetime] = utc_now,
                 sleep: Callable[[float], None] | None = None):
        self.repo = repo
        self.cli = cli
        self.settings = settings
        self.now = now
        self._lock = threading.RLock()
        self._wake = threading.Event()
        # stop-and-wait logic and the trust rules are the same as for tasks
        self._sessions = SessionRunner(repo, cli, settings, on_event=lambda *a, **k: None,
                                       **({"sleep": sleep} if sleep else {}))

    # ---------- commands ----------

    def send(self, chat: Chat, body: str) -> dict:
        with self._lock:
            message = self.repo.add_chat_message(chat.id, "user", body, state="queued")
            fields: dict = {}
            if not chat.title:
                fields["title"] = " ".join(body.split())[:TITLE_CHARS]
            current = self.repo.get_chat(chat.id)
            if current is not None and current.status == "idle":
                fields["status"] = "queued"
            if fields:
                self.repo.update_chat(chat.id, **fields)
        self._wake.set()
        return message

    def wake(self) -> None:
        """Start looking at queued chats now instead of on the next idle poll."""
        self._wake.set()

    def stop_turn(self, chat_id: int) -> Chat:
        """The Stop button: end the current turn and drop what was queued behind it."""
        with self._lock:
            chat = self.repo.get_chat(chat_id)
            if chat is None:
                raise ChatError("chat not found")
            for message in self.repo.list_chat_messages(chat_id, role="user", state="queued"):
                self.repo.update_chat_message(message["id"], state="cancelled")
            if chat.status == "idle":
                return chat
            if chat.status in ("running", "waiting"):
                self._drain(chat, None)
                self._release(chat)
                self.repo.add_chat_message(chat_id, "system", "stopped by the owner")
            return self.repo.update_chat(chat_id, status="idle", waiting_detail=None)

    def delete(self, chat_id: int) -> None:
        """Shut the session down and remove the chat's folder and branch. Its commits go with them:
        the UI says so before asking."""
        with self._lock:
            chat = self.repo.get_chat(chat_id)
            if chat is None:
                return
            self._release(chat)
            if chat.job_id:
                try:
                    self.cli.remove(chat.job_id)
                except Exception:
                    log.warning("claude rm %s (chat #%s) failed", chat.job_id, chat_id, exc_info=True)
            self._remove_folder(chat)
            self.repo.delete_chat(chat_id)

    def accept_proposal(self, chat: Chat, message: dict, base_branch: str) -> dict:
        """A proposal becomes a backlog card, and only by the owner's hand. So do the open proposals it
        waits for: the owner agreed to this step of a chain, and the step means nothing without them."""
        project = self.repo.get_project(chat.project_id) if chat.project_id else None
        if project is None:
            raise ChatError("the chat is not attached to a project")
        accepted: list[int] = []
        task_id = self._accept_chain(chat, project, message, base_branch, accepted)
        return {"task_id": task_id, "accepted": accepted}

    def _accept_chain(self, chat: Chat, project: Project, message: dict, base_branch: str, accepted: list[int]) -> int:
        data = json.loads(message["body"])
        blockers: list[int] = []
        # Rings were refused when the block was read (_take_proposals), so this walk ends
        for other_id in data.get("depends_on_messages") or []:
            other = self.repo.get_chat_message(other_id)
            if other is None or other["chat_id"] != chat.id:
                continue
            if other["state"] == "open":
                blockers.append(self._accept_chain(chat, project, other, base_branch, accepted))
            elif other["state"] == "accepted":
                blockers.append(json.loads(other["body"]).get("task_id"))
            # A dismissed proposal is the owner saying this step does not need that one
        blockers += data.get("depends_on_tasks") or []
        blockers = [b for b in blockers if b is not None and self.repo.get_task(b) is not None]
        agent = self.repo.find_agent_by_name(data["agent"]) if data.get("agent") else None
        if agent is not None and agent.project_id not in (None, project.id):
            agent = None
        # Whatever the project's base is now, a step must land where the steps before it landed
        target = task_plans.common_blocker_branch(map(self.repo.get_task, blockers), project.id) or base_branch
        task = self.repo.add_task(project.id, data["title"], data.get("description") or "", target_branch=target,
                                  depends_on=blockers, agent_id=agent.id if agent else None)
        data["task_id"] = task.id
        self.repo.update_chat_message(message["id"], state="accepted", body=json.dumps(data, ensure_ascii=False))
        self.repo.add_event(f"#{task.id} created from a proposal in chat #{chat.id}", task_id=task.id,
                            project_id=project.id)
        accepted.append(task.id)
        return task.id

    # ---------- the loop ----------

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            active = False
            try:
                active = self.tick()
            except Exception:
                log.exception("chat tick failed")
            self._wake.wait(ACTIVE_POLL_SEC if active else IDLE_POLL_SEC)
            self._wake.clear()

    def tick(self) -> bool:
        """One pass over active chats. Returns whether anything is still going on."""
        with self._lock:
            for chat in self.repo.active_chats():
                try:
                    if chat.status == "queued":
                        self._begin_turn(chat)
                    else:
                        self._poll(chat)
                except Exception as e:
                    log.exception("chat #%s", chat.id)
                    self._fail_turn(chat, str(e))
            return bool(self.repo.active_chats())

    def _fail_turn(self, chat: Chat, reason: str) -> None:
        """Messages that did not get through are marked, not retried: the failure is usually not
        transient (a moved folder, an untrusted project), and a retry loop would repeat it forever."""
        for message in self.repo.list_chat_messages(chat.id, role="user", state="queued"):
            self.repo.update_chat_message(message["id"], state="failed")
        self._cancel_requests(chat.id)
        self.repo.add_chat_message(chat.id, "system", reason)
        self.repo.update_chat(chat.id, status="idle", waiting_detail=None)

    # ---------- start of a turn ----------

    def _begin_turn(self, chat: Chat) -> None:
        queued = self.repo.list_chat_messages(chat.id, role="user", state="queued")
        if not queued:
            self.repo.update_chat(chat.id, status="idle")
            return
        agent = self.repo.get_agent(chat.agent_id)
        project = self.repo.get_project(chat.project_id) if chat.project_id else None
        if agent is None:
            raise ChatError("the agent no longer exists")
        if chat.project_id and project is None:
            raise ChatError("the project no longer exists")
        chat = self._ensure_folder(chat, project)
        is_lead = project is not None and project.lead_agent_id == agent.id
        text = "\n\n".join(m["body"] for m in queued)
        if is_lead:
            text = board_context(self.repo, project, agent) + text
        offset = self._transcript_size(chat.transcript_path)
        job_id = self._launch(chat, agent, project, is_lead, text)
        if job_id is None:
            return  # the previous process has not stopped yet: the next pass tries again
        st = self.cli.read_state(job_id)
        for message in queued:
            self.repo.update_chat_message(message["id"], state="sent")
        self.repo.update_chat(
            chat.id, status="running", job_id=job_id, waiting_detail=None,
            session_id=(st.session_id if st else None) or chat.session_id,
            transcript_path=(st.transcript_path if st else None) or chat.transcript_path,
            transcript_offset=offset, turn_started_at=self.now().isoformat(), turn_progress=0,
        )

    def _launch(self, chat: Chat, agent: Agent, project: Project | None, is_lead: bool, text: str) -> str | None:
        cwd = Path(chat.cwd)
        if chat.session_id is None:
            params = agents.resolve_params(None, agent, project)
            return self._run_cli(project, cwd, lambda: self.cli.start_bg(
                cwd=cwd, prompt=text, name=f"orc-chat#{chat.id} {agent.name}",
                model=params.model, effort=params.effort, permission_mode=params.permission_mode,
                settings=self._session_settings(agent, chat),
                append_system_prompt=chat_system_prompt(agent, project, is_lead, chat, self.settings.data_dir),
            ))
        st = self._state(chat)
        if st is not None and st.state not in RESUMABLE_STATES:
            self.cli.stop(chat.job_id)
            if not self._stopped(chat):
                return None
            st = self._state(chat)
        # Waking a stopped session keeps its saved options, and flags would turn it into a copy. A job
        # that is gone or finished by itself has no options left, so a copy gets them again.
        stopped = st is not None and st.state == "stopped"
        return self._run_cli(project, cwd, lambda: self.cli.resume_bg(
            cwd=cwd, session_id=chat.session_id, prompt=text,
            settings=None if stopped else self._session_settings(agent, chat),
            append_system_prompt=None if stopped else chat_system_prompt(agent, project, is_lead, chat, self.settings.data_dir),
        ))

    def _run_cli(self, project: Project | None, cwd: Path, run: Callable[[], str]) -> str:
        if project is None:
            return run()
        return self._sessions.launch(project.path, cwd, run)

    def _session_settings(self, agent: Agent, chat: Chat) -> str:
        """`--settings` of a chat session: the statusline, the agent's memory and the input-request hook.

        Without the hook a permission dialog in a background session is seen by nobody and the turn stands
        forever. The secret is reissued with every set of settings, like a task's: an old command line
        stops opening anything."""
        secret = secrets.token_urlsafe(32)
        path = inputs.write_hook_secret(inputs.chat_hook_secret_path(self.settings.data_dir, chat.id), secret)
        self.repo.update_chat(chat.id, touch=False, hook_secret=secret)
        return json.dumps({**usage.statusline_settings(self.settings.usage_cache_path),
                           **agents.memory_settings(self.settings.data_dir, agent),
                           "hooks": inputs.hook_settings(self.settings.api_base, secret_path=str(path), chat_id=chat.id)},
                          ensure_ascii=False)

    # ---------- input requests from the session ----------

    def request_input(self, chat_id: int, kind: str, tool_name: str, tool_input: dict) -> dict:
        """The session hook reports that the agent waits for the owner. Deliberately without the loop's lock:
        the hook holds a tool of a live agent, and a refusal would hand it over to a dialog nobody sees."""
        chat = self.repo.get_chat(chat_id)
        if chat is None or chat.status not in ("running", "waiting"):
            raise ChatError("the chat has no running turn: input requests are accepted only from a running session")
        if kind not in inputs.KINDS:
            raise ChatError(f"kind: {' | '.join(sorted(inputs.KINDS))}")
        self._cancel_requests(chat_id)
        summary = inputs.summarize(kind, tool_name, tool_input)
        body = json.dumps({"kind": kind, "tool_name": tool_name, "tool_input": tool_input, "summary": summary,
                           "decision": None, "answered_at": None}, ensure_ascii=False)
        message = self.repo.add_chat_message(chat_id, INPUT_REQUEST_ROLE, body, state="open")
        self.repo.update_chat(chat_id, status="waiting", waiting_detail=summary)
        return message

    def answer_input(self, chat_id: int, message_id: int, decision: dict) -> dict:
        """The owner's decision: the hook picks it up on its next poll and hands it to the session."""
        message = self.repo.get_chat_message(message_id)
        if message is None or message["chat_id"] != chat_id or message["role"] != INPUT_REQUEST_ROLE:
            raise ChatError("the chat has no such request")
        if message["state"] != "open":
            raise ChatError("the request is already closed: the session is no longer waiting for it")
        data = json.loads(message["body"])
        clean = inputs.validate_decision(data["kind"], data["tool_input"], decision)
        data.update(decision=clean, answered_at=self.now().isoformat())
        self.repo.update_chat_message(message_id, state="answered", body=json.dumps(data, ensure_ascii=False))
        chat = self.repo.get_chat(chat_id)
        if chat is not None and chat.status == "waiting":
            self.repo.update_chat(chat_id, status="running", waiting_detail=None)
        return self.repo.get_chat_message(message_id)

    def _open_request(self, chat_id: int) -> dict | None:
        opened = self.repo.list_chat_messages(chat_id, role=INPUT_REQUEST_ROLE, state="open")
        return opened[-1] if opened else None

    def _cancel_requests(self, chat_id: int) -> None:
        """The session is going away or asked again: nobody is left to fulfil the open request."""
        for message in self.repo.list_chat_messages(chat_id, role=INPUT_REQUEST_ROLE, state="open"):
            self.repo.update_chat_message(message["id"], state="cancelled")

    def _answered_recently(self, chat_id: int) -> bool:
        for message in reversed(self.repo.list_chat_messages(chat_id, role=INPUT_REQUEST_ROLE, state="answered")):
            try:
                at = datetime.fromisoformat(json.loads(message["body"]).get("answered_at") or "")
            except ValueError:
                return False
            return (self.now() - at).total_seconds() < INPUT_ANSWER_GRACE_SEC
        return False

    def _ensure_folder(self, chat: Chat, project: Project | None) -> Chat:
        if chat.cwd and Path(chat.cwd).is_dir():
            return chat
        if project is None:
            path = Path(self.settings.data_dir).resolve() / "chats" / str(chat.id)
            path.mkdir(parents=True, exist_ok=True)
            # orc made this empty folder itself, so unlike a project there is nothing for the owner to vet
            trust.grant(self.settings.claude_json_path, path)
            return self.repo.update_chat(chat.id, cwd=str(path))
        repo_path = Path(project.path)
        path = worktree_path(project, chat.id)
        branch = chat.branch or f"orc/chat-{chat.id}"
        if branch in git_ops.list_branches(repo_path):
            # The folder was removed by hand in the Worktrees window, the branch survived
            git_ops.prune_worktrees(repo_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            git_ops.git(["worktree", "add", str(path), branch], repo_path)
        else:
            base = branches.base_branch(project, git_ops.current_branch(repo_path))
            git_ops.add_worktree(repo_path, path, branch, base)
        return self.repo.update_chat(chat.id, cwd=str(path), branch=branch)

    def _remove_folder(self, chat: Chat) -> None:
        if not chat.cwd:
            return
        path = Path(chat.cwd)
        project = self.repo.get_project(chat.project_id) if chat.project_id else None
        try:
            if project is not None and chat.branch:
                repo_path = Path(project.path)
                if repo_path.is_dir():
                    if path.is_dir():
                        git_ops.git(["worktree", "remove", "--force", str(path)], repo_path)
                    git_ops.prune_worktrees(repo_path)
                    if chat.branch in git_ops.list_branches(repo_path):
                        git_ops.delete_branch(repo_path, chat.branch)
            shutil.rmtree(path, ignore_errors=True)
            trust.revoke(self.settings.claude_json_path, path)
        except Exception:
            log.warning("cleaning up the folder of chat #%s", chat.id, exc_info=True)

    # ---------- a running turn ----------

    def _poll(self, chat: Chat) -> None:
        st = self._state(chat)
        fields: dict = {}
        if st is not None:
            if st.session_id and st.session_id != chat.session_id:
                fields["session_id"] = st.session_id
            if st.transcript_path and st.transcript_path != chat.transcript_path:
                # A copy may write a new file: read it from the start, the timestamps cut off the history
                fields["transcript_path"] = st.transcript_path
                fields["transcript_offset"] = 0
        if fields:
            chat = self.repo.update_chat(chat.id, **fields)
        self._drain(chat, st)
        chat = self.repo.get_chat(chat.id)
        queued = self.repo.list_chat_messages(chat.id, role="user", state="queued")

        pending = self._open_request(chat.id)
        if pending is not None:
            # The hook holds the tool and the dashboard shows the request: the owner answers it there. A new
            # message is still the way out, it stops the session (and with it the hook).
            summary = json.loads(pending["body"])["summary"]
            if queued:
                self._release(chat)
                self.repo.update_chat(chat.id, status="queued", waiting_detail=None)
            elif chat.status != "waiting" or chat.waiting_detail != summary:
                self.repo.update_chat(chat.id, status="waiting", waiting_detail=summary)
            return
        if (st is not None and st.state == "working" and (st.tempo == "blocked" or st.needs)
                and not self._answered_recently(chat.id)):
            # A dialog the hook did not catch (orc was unreachable, a session from before the hooks). A new
            # message from the owner is the way out: the session is stopped and continues with that text.
            if queued:
                self._release(chat)
                self.repo.update_chat(chat.id, status="queued", waiting_detail=None)
            elif chat.status != "waiting" or chat.waiting_detail != (st.needs or st.detail):
                self.repo.update_chat(chat.id, status="waiting", waiting_detail=st.needs or st.detail)
            return
        if chat.status == "waiting":
            chat = self.repo.update_chat(chat.id, status="running", waiting_detail=None)

        over = st is None or st.state in STOP_TERMINAL_STATES or (st.turn_ended and (st.in_flight == 0 or st.only_timers))
        if not over:
            return
        if not chat.turn_progress and self._turn_age_sec(chat) < TURN_START_GRACE_SEC:
            return  # the state may still describe the previous turn
        self._finish_turn(chat, st, bool(queued))

    def _finish_turn(self, chat: Chat, st: JobState | None, more: bool) -> None:
        if not chat.turn_progress:
            detail = (st.detail if st else "") or "the session ended without a reply"
            self.repo.add_chat_message(chat.id, "system", detail)
        self._collect_usage(chat)
        self._release(chat)
        self.repo.update_chat(chat.id, status="queued" if more else "idle", waiting_detail=None)

    def _drain(self, chat: Chat, st: JobState | None) -> None:
        """New complete transcript lines → chat messages; the offset moves in the same step."""
        path = chat.transcript_path
        if not path:
            return
        try:
            with open(path, "rb") as f:
                f.seek(chat.transcript_offset)
                chunk = f.read()
        except OSError:
            return
        # A line still being written stays for the next pass
        end = chunk.rfind(b"\n") + 1
        if end == 0:
            return
        lines = chunk[:end].decode("utf-8", errors="replace").splitlines()
        since = None
        if chat.turn_started_at:
            try:
                since = datetime.fromisoformat(chat.turn_started_at).timestamp()
            except ValueError:
                pass
        parsed = parse_turn_lines(lines, since)
        is_lead = self._is_lead(chat)
        for role, body in parsed:
            if role == "assistant" and is_lead:
                body = self._take_proposals(chat, body)
            if body:
                self.repo.add_chat_message(chat.id, role, body)
        fields: dict = {"transcript_offset": chat.transcript_offset + end}
        if parsed:
            fields["turn_progress"] = 1
        self.repo.update_chat(chat.id, **fields)

    def _is_lead(self, chat: Chat) -> bool:
        project = self.repo.get_project(chat.project_id) if chat.project_id else None
        return project is not None and project.lead_agent_id == chat.agent_id

    def _take_proposals(self, chat: Chat, body: str) -> str:
        """Turn the marked blocks of a lead's reply into proposal messages; returns what is left of the text.

        The order on screen follows the reply: the lead's words first, then the cards it speaks about.
        """
        text, items, error = split_proposals(body)
        if text:
            self.repo.add_chat_message(chat.id, "assistant", text)
        if error:
            self.repo.add_chat_message(chat.id, "system", error)
        valid = [i for i in items if isinstance(i, dict) and str(i.get("title") or "").strip()]
        kept = valid[:PROPOSALS_MAX]
        cards = []
        for item in kept:
            agent = item.get("agent")
            cards.append({
                "title": str(item["title"]).strip()[:200],
                "description": str(item.get("description") or ""),
                "agent": agent if isinstance(agent, str) and agent else None,
            })
        # Links need the message ids, so the cards are written first and linked afterwards
        ids = [self.repo.add_chat_message(chat.id, "proposal", json.dumps(card, ensure_ascii=False), state="open")["id"]
               for card in cards]
        self._link_proposals(chat, kept, cards, ids)
        if len(valid) > PROPOSALS_MAX:
            self.repo.add_chat_message(chat.id, "system", f"only the first {PROPOSALS_MAX} of {len(valid)} proposed tasks are shown")
        return ""

    def _link_proposals(self, chat: Chat, items: list[dict], cards: list[dict], ids: list[int]) -> None:
        """The depends_on of a proposal block, as message ids and task numbers. A link that cannot be read
        is dropped with a note: the cards themselves are still worth showing to the owner."""
        by_ref = {str(item["ref"]): i for i, item in enumerate(items) if item.get("ref")}
        local: dict[int, list[int]] = {}
        existing: dict[int, list[int]] = {}
        dropped: list[str] = []
        for i, item in enumerate(items):
            local[i], existing[i] = [], []
            deps = item.get("depends_on")
            for dep in deps if isinstance(deps, list) else []:
                if str(dep) in by_ref and by_ref[str(dep)] != i:
                    local[i].append(by_ref[str(dep)])
                elif isinstance(dep, int) and not isinstance(dep, bool) and self.repo.get_task(dep) is not None:
                    existing[i].append(dep)
                elif isinstance(dep, str) and dep.isdigit() and self.repo.get_task(int(dep)) is not None:
                    existing[i].append(int(dep))
                else:
                    dropped.append(str(dep))
        try:
            task_plans.topological_order(local)
        except task_plans.CycleError:
            self.repo.add_chat_message(chat.id, "system", "the proposed tasks wait for each other in a ring, so their links were dropped")
            return
        if dropped:
            self.repo.add_chat_message(chat.id, "system", f"could not resolve these depends_on values, so they were dropped: {', '.join(dropped)}")
        for i, card in enumerate(cards):
            if not local[i] and not existing[i]:
                continue
            linked = {**card, "depends_on_messages": [ids[j] for j in local[i]], "depends_on_tasks": existing[i],
                      "waits_for": [cards[j]["title"] for j in local[i]] + [f"#{t}" for t in existing[i]]}
            self.repo.update_chat_message(ids[i], body=json.dumps(linked, ensure_ascii=False))

    def _collect_usage(self, chat: Chat) -> None:
        """Chat tokens spend the same limits as task tokens, so they go into the same spending log."""
        try:
            chat = self.repo.get_chat(chat.id)
            if not chat.transcript_path:
                return
            previous = json.loads(chat.usage_json) if chat.usage_json else None
            if previous is not None and previous.get("transcript") != chat.transcript_path:
                previous = None  # a new file of a copy: its own count starts from zero
            current = token_usage.collect(
                [token_usage.SessionRef(chat.session_id, chat.job_id, chat.transcript_path)], now=self.now())
            current["transcript"] = chat.transcript_path
            self.repo.update_chat(chat.id, usage_json=json.dumps(current, ensure_ascii=False))
            tokens = current.get("total_tokens", 0) - (previous.get("total_tokens", 0) if previous else 0)
            cost = ledger_cost(current) - (ledger_cost(previous) if previous else 0.0)
            if tokens > 0 or cost > 0:
                self.repo.add_usage_entry(None, chat.project_id, max(tokens, 0), round(max(cost, 0.0), 6),
                                          at=self.now().replace(microsecond=0).isoformat())
        except Exception:
            log.exception("token collection for chat #%s", chat.id)

    # ---------- session helpers ----------

    def _state(self, chat: Chat) -> JobState | None:
        return self._sessions.safe_state(chat.job_id) if chat.job_id else None

    def _stopped(self, chat: Chat) -> bool:
        return self._sessions.wait_stopped(_JobRef(chat.job_id, chat.id))

    def _release(self, chat: Chat) -> None:
        self._cancel_requests(chat.id)
        st = self._state(chat)
        if chat.job_id and (st is None or st.state not in STOP_TERMINAL_STATES):
            try:
                self.cli.stop(chat.job_id)
            except Exception:
                log.warning("claude stop %s (chat #%s) failed", chat.job_id, chat.id, exc_info=True)

    def _turn_age_sec(self, chat: Chat) -> float:
        if not chat.turn_started_at:
            return timedelta.max.total_seconds()
        try:
            return (self.now() - datetime.fromisoformat(chat.turn_started_at)).total_seconds()
        except ValueError:
            return timedelta.max.total_seconds()

    @staticmethod
    def _transcript_size(path: str | None) -> int:
        try:
            return Path(path).stat().st_size if path else 0
        except OSError:
            return 0


class _JobRef:
    """What SessionRunner.wait_stopped reads from a task: the job and a number for its log lines."""

    def __init__(self, job_id: str | None, chat_id: int):
        self.job_id = job_id
        self.id = chat_id
