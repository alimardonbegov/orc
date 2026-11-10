"""`orc task ...`: the board for agents and scripts. A thin client of the running server.

It goes through the HTTP API rather than the database: the rules live there, and there is no lock
between processes (the README says the same about `orc tick`).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from orc import task_guide
from orc.config import default_data_dir
from orc.inputs import LEGACY_HOOK_SECRET_REL_PATH, hook_secret_path
from orc.security import PULT_TOKEN_FILE

DEFAULT_URL = "http://127.0.0.1:8765"
SERVER_URL_FILE = "server-url"
REQUEST_TIMEOUT_SEC = 30
# What `edit --clear` can empty, so that the agent's or the project's value applies again
CLEARABLE = ("agent", "verify_cmd", "start_after", "start_before",
             "start_date", "due_date", "parent", "stage", "wake_on_children")


class CliError(RuntimeError):
    """Said to the caller as it is, and the command exits with 1."""


# The CLI is an editable install and changes the moment a merge lands, while the running server stays as it was
# until the owner restarts it. A new field sent to an old server is refused or silently dropped; either way
# the caller must hear why.
OLDER_SERVER = ("the server is older than this CLI and does not know {what}: restart orc, or hand in the way "
                "your prompt says")


# (method, path, payload) → parsed JSON, with an optional hook_secret keyword for the /api/hooks/ endpoints
# that speak for a session. Replaced in tests.
Transport = Callable[..., Any]


def data_dir() -> Path:
    return Path(os.environ.get("ORC_DATA_DIR") or default_data_dir())


def write_server_url(directory: Path, url: str) -> None:
    """`orc serve` says where it listens: a client of this data directory should not have to guess the port."""
    (directory / SERVER_URL_FILE).write_text(url, encoding="utf-8")


def server_url(directory: Path) -> str:
    from_env = os.environ.get("ORC_URL")
    if from_env:
        return from_env.rstrip("/")
    try:
        return (directory / SERVER_URL_FILE).read_text(encoding="utf-8").strip().rstrip("/") or DEFAULT_URL
    except OSError:
        return DEFAULT_URL


def http_transport(directory: Path) -> Transport:
    url = server_url(directory)
    # No proxies: the API answers only on this machine, and a corporate proxy from the environment would
    # turn every call into an obscure refusal.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(method: str, path: str, payload: dict | None, hook_secret: str | None = None) -> Any:
        headers = {"Content-Type": "application/json"}
        if hook_secret is not None:
            headers["X-Orc-Hook"] = hook_secret  # this door takes the task's own secret, not the dashboard's token
        elif method != "GET":
            token_path = directory / PULT_TOKEN_FILE
            try:
                headers["X-Orc-Token"] = token_path.read_text(encoding="utf-8").strip()
            except OSError:
                raise CliError(f"no token at {token_path}: this is not the data directory of a running orc. "
                               f"Start `orc serve`, or set ORC_DATA_DIR")
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(url + path, data=body, method=method, headers=headers)
        try:
            with opener.open(request, timeout=REQUEST_TIMEOUT_SEC) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise CliError(_error_text(e.read().decode("utf-8", errors="replace")))
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise CliError(f"orc is not answering at {url} ({e}): start it with `orc serve`, or set ORC_URL") from e

    return call


def _error_text(raw: str) -> str:
    try:
        detail = json.loads(raw).get("detail")
    except (ValueError, AttributeError):
        return raw
    if isinstance(detail, list):  # a validation error: name the field, an agent can act on that
        return "; ".join(f"{'.'.join(str(p) for p in item.get('loc', [])[1:])}: {item.get('msg')}" for item in detail)
    return str(detail)


def _with_key(payload: dict, enabled: bool) -> dict:
    """A session that lost the answer and asks again must not get a second set of cards. The payload holds
    the folder, so two cards asking for the same thing are not taken for one request repeated."""
    if not enabled or payload.get("idempotency_key"):
        return payload
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return {**payload, "idempotency_key": hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]}


def _read_text(path: str, what: str) -> str:
    try:
        return sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise CliError(f"cannot read {what} from {path}: {e}")


def _print_batch(result: dict) -> None:
    if result.get("duplicate"):
        print("the same request was already made, nothing new was created:")
    for card in result["created"]:
        waits = ", ".join(f"#{d}" for d in card["depends_on"])
        labels = ", ".join(card.get("labels") or [])
        parent = card.get("parent_task_id")
        print(f"#{card['id']} {card['title']}  [{card['status']}, base {card['target_branch']}"
              + (f", waits for {waits}" if waits else "") + (f", subtask of #{parent}" if parent else "") + (f", stage {card['stage']}" if card.get("stage") else "")
              + (f", labels {labels}" if labels else "") + "]")
    for warning in result.get("warnings", []):
        print(f"note: {warning}")


def _planning_fields(args: argparse.Namespace) -> dict:
    """Only what was asked for: a flag that was not passed must not reach an older server."""
    fields: dict = {}
    for field in ("start_date", "due_date"):
        if getattr(args, field, None) is not None:
            fields[field] = getattr(args, field)
    return fields


def _list_labels(call: Transport) -> list[dict]:
    try:
        return call("GET", "/api/labels", None)
    except CliError as e:
        if "not found" in str(e).lower():
            raise CliError(OLDER_SERVER.format(what="labels")) from e
        raise


def _label_id(name: str, call: Transport) -> int:
    found = next((item for item in _list_labels(call) if item["name"].casefold() == name.strip().casefold()), None)
    if found is None:
        raise CliError(f"label {name!r} not found")
    return found["id"]


def _cmd_add(args: argparse.Namespace, call: Transport) -> Any:
    if args.description is not None and args.description_file is not None:
        raise CliError("--description and --description-file: pick one")
    description = args.description or ""
    if args.description_file is not None:
        description = _read_text(args.description_file, "the description")
    card: dict = {"title": args.title, "description": description, "depends_on": args.after or []}
    for field in ("status", "priority", "agent", "verify_cmd",
                  "start_after", "start_before"):
        value = getattr(args, field)
        if value is not None:
            card[field] = value
    card.update(_planning_fields(args))
    if args.label:
        card["labels"] = args.label
    if args.stage is not None:
        card["stage"] = args.stage  # only when asked: an older server forbids unknown fields in a plan
    payload = {"project": args.project, "cwd": os.getcwd(), "target_branch": args.base,
               "create_target_from": args.base_from, "tasks": [card]}
    # Only when asked: the default, a subtask of the calling card, needs no field an older server would refuse
    if args.parent is not None:
        payload["parent"] = _task_id(args.parent, call)
    if args.no_parent:
        payload["no_parent"] = True
    try:
        return call("POST", "/api/tasks/batch", _with_key(payload, not args.no_dedupe))
    except CliError as e:
        # An older server forbids unknown fields in a plan
        if "extra inputs" in str(e).lower():
            if args.parent is not None or args.no_parent:
                raise CliError(OLDER_SERVER.format(what="subtasks")) from e
            if args.stage is not None:
                raise CliError(OLDER_SERVER.format(what="stages")) from e
            if args.label or _planning_fields(args):
                raise CliError(OLDER_SERVER.format(what="labels or dates")) from e
        raise


def _cmd_batch(args: argparse.Namespace, call: Transport) -> Any:
    raw = _read_text(args.file, "the plan")
    try:
        plan = json.loads(raw)
    except ValueError as e:
        raise CliError(f"the plan is not valid JSON: {e}")
    if isinstance(plan, list):  # the bare list of cards is the natural first guess, and it is unambiguous
        plan = {"tasks": plan}
    if not isinstance(plan, dict):
        raise CliError("the plan must be a JSON object with a \"tasks\" list")
    plan = {**plan, "cwd": os.getcwd()}
    if args.project:
        plan = {k: v for k, v in plan.items() if k != "project_id"} | {"project": args.project}
    return call("POST", "/api/tasks/batch", _with_key(plan, not args.no_dedupe))


def _caller_id(call: Transport) -> int | None:
    """The card whose worktree this command runs in, or None."""
    query = urllib.parse.urlencode({"cwd": os.getcwd()})
    caller = call("GET", "/api/tasks/context?" + query, None).get("caller")
    return caller["id"] if caller else None


def _task_id(raw: str, call: Transport) -> int:
    """A card number, or `current` for the card this command runs in."""
    if raw == "current":
        found = _caller_id(call)
        if found is None:
            raise CliError("current means the card this command runs in, and this folder is not the worktree of any card")
        return found
    if raw.lstrip("#").isdigit():
        return int(raw.lstrip("#"))
    raise CliError(f"{raw!r} is not a card number (or current)")


def _project_ref(name: str, call: Transport) -> dict:
    ctx = call("GET", "/api/tasks/context?" + urllib.parse.urlencode({"cwd": os.getcwd(), "project": name}), None)
    if not ctx.get("project"):
        raise CliError(f"project {name!r} not found")
    return ctx["project"]


def _agent_id(name: str, project_id: int, call: Transport) -> int:
    """An agent usable in the project, by name or id."""
    if name.isdigit():
        return int(name)
    agents = call("GET", f"/api/agents?project_id={project_id}", None)
    found = next((a for a in agents if a["name"].casefold() == name.strip().casefold()), None)
    if found is None:
        raise CliError(f"agent {name!r} not found. Agents of this project: {', '.join(a['name'] for a in agents) or 'none'}")
    return found["id"]


def _cmd_link(args: argparse.Namespace, call: Transport) -> Any:
    if not args.after and not args.remove:
        raise CliError("nothing to do: pass --after or --remove")
    payload = {"add": args.after or [], "remove": args.remove or [], "cwd": os.getcwd()}
    return call("POST", f"/api/tasks/{_task_id(args.task, call)}/dependencies", payload)


def _cmd_show(args: argparse.Namespace, call: Transport) -> Any:
    return call("GET", f"/api/tasks/{_task_id(args.task, call)}", None)


def _cmd_list(args: argparse.Namespace, call: Transport) -> Any:
    ctx = call("GET", "/api/tasks/context?" + urllib.parse.urlencode(
        {"cwd": os.getcwd(), **({"project": args.project} if args.project else {})}), None)
    if args.project and not ctx.get("project"):
        raise CliError(f"project {args.project!r} not found")
    query: dict = {"archived": args.archived}
    if ctx.get("project"):
        query["project_id"] = ctx["project"]["id"]
    if args.status:
        query["status"] = args.status
    if args.label:
        query["label_id"] = _label_id(args.label, call)
    return {"projects": {p["id"]: p["name"] for p in ctx["projects"]},
            "tasks": call("GET", "/api/tasks?" + urllib.parse.urlencode(query), None)}


def _cmd_edit(args: argparse.Namespace, call: Transport) -> Any:
    if args.description is not None and args.description_file is not None:
        raise CliError("--description and --description-file: pick one")
    task_id = _task_id(args.task, call)
    changes: dict = {}
    for field in ("title", "priority", "status", "verify_cmd",
                  "start_after", "start_before"):
        if getattr(args, field) is not None:
            changes[field] = getattr(args, field)
    if args.base is not None:
        changes["target_branch"] = args.base
    if args.description_file is not None:
        changes["description"] = _read_text(args.description_file, "the description")
    elif args.description is not None:
        changes["description"] = args.description
    before = call("GET", f"/api/tasks/{task_id}", None)
    changes.update(_planning_fields(args))
    if args.label or args.remove_label:
        if "labels" not in before:
            raise CliError(OLDER_SERVER.format(what="labels"))
        names = [item["name"] for item in before["labels"]]
        names = [n for n in names if n.casefold() not in {r.strip().casefold() for r in args.remove_label or []}]
        known = {n.casefold() for n in names}
        names += [n for n in dict.fromkeys(args.label or []) if n.strip().casefold() not in known]
        changes["labels"] = names
    if args.agent is not None:
        changes["agent_id"] = _agent_id(args.agent, before["project_id"], call)
    if args.parent is not None:
        changes["parent_task_id"] = _task_id(args.parent, call)
    if args.wake_on_children or args.no_wake_on_children:
        changes["wake_on_children"] = bool(args.wake_on_children)
    if args.stage is not None:
        changes["stage"] = args.stage
    renamed = {"agent": "agent_id", "parent": "parent_task_id"}
    for field in args.clear or []:
        if field in changes or renamed.get(field) in changes:
            raise CliError(f"--clear {field} and a new value for it: pick one")
        changes[renamed.get(field, field)] = None
    if not changes:
        raise CliError("nothing to change: pass a field to set, or --clear FIELD")
    if changes.get("status") == "done" and not args.force:
        raise CliError("--status done closes the card without verification and merge: add --force if you mean it")
    changes["cwd"] = os.getcwd()
    if args.force:
        changes["force"] = True
    after = call("PATCH", f"/api/tasks/{task_id}", changes)
    if any(k in changes for k in ("labels", "start_date", "due_date")) and "labels" not in after:
        # An older server ignores fields it does not know and answers as if nothing was asked
        raise CliError(OLDER_SERVER.format(what="labels or dates"))
    if "parent_task_id" in changes and "parent_task_id" not in after:
        raise CliError(OLDER_SERVER.format(what="subtasks"))
    if "wake_on_children" in changes and "wake_on_children" not in after:
        raise CliError(OLDER_SERVER.format(what="waking a parent when its subtasks are done"))
    if "stage" in changes and "stage" not in after:
        raise CliError(OLDER_SERVER.format(what="stages"))
    if after["status"] != before["status"] and "status" not in changes:
        after["note"] = f"#{task_id} went from {before['status']} to {after['status']}: a card without an agent cannot be queued"
    return after


def _cmd_move(args: argparse.Namespace, call: Transport) -> Any:
    payload: dict = {"project": args.to, "cwd": os.getcwd()}
    if args.base is not None:
        payload["target_branch"] = args.base
    if args.agent is not None:
        payload["agent"] = args.agent
    return call("POST", f"/api/tasks/{_task_id(args.task, call)}/move", payload)


def _cmd_archive(args: argparse.Namespace, call: Transport) -> Any:
    return call("POST", f"/api/tasks/{_task_id(args.task, call)}/{args.action}", {})


def _cmd_delete(args: argparse.Namespace, call: Transport) -> Any:
    task_id = _task_id(args.task, call)
    if not args.yes:
        raise CliError(f"deleting #{task_id} is irreversible, and `orc task archive {task_id}` can be undone: "
                       f"pass --yes if you mean to delete")
    if task_id == _caller_id(call):
        raise CliError(f"#{task_id} is the card this command runs in: deleting it would cut off your own session")
    query = {"force": str(args.force).lower(), "drop_worktree": str(not args.keep_worktree).lower()}
    return call("DELETE", f"/api/tasks/{task_id}?" + urllib.parse.urlencode(query), None)


def _hook_secret(task_id: int, start: Path) -> str:
    """The secret orc issued to this card's session. It lives in orc's data directory, so it survives a working
    copy that was deleted and made again. Sessions issued before that keep it in the working copy, above `start`."""
    path = hook_secret_path(data_dir(), task_id)
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    for folder in (start, *start.parents):
        try:
            return (folder / LEGACY_HOOK_SECRET_REL_PATH).read_text(encoding="utf-8").strip()
        except OSError:
            continue
    raise CliError(f"no secret for card #{task_id} at {path}: orc issues it together with the card's session, "
                   f"so ask the owner to resume the session, or to accept the work")


def _cmd_handoff(args: argparse.Namespace, call: Transport) -> Any:
    """`done` and `fail` take no card number: they speak for the card this session belongs to."""
    if args.action == "fail":
        status, summary = "failed", args.reason
    else:
        if args.summary is not None and args.summary_file is not None:
            raise CliError("--summary and --summary-file: pick one")
        status = "done"
        summary = args.summary if args.summary_file is None else _read_text(args.summary_file, "the summary")
    task_id = _caller_id(call)
    if task_id is None:
        raise CliError("this folder is not the worktree of any card: only the session of a card can hand it in")
    return call("POST", f"/api/hooks/tasks/{task_id}/handoff", {"status": status, "summary": summary or ""},
                hook_secret=_hook_secret(task_id, Path.cwd()))


def _cmd_attach(args: argparse.Namespace, call: Transport) -> Any:
    """Hand in files as the card's result. Speaks for the card of this session, like `done`; a name handed in again
    becomes the next version."""
    task_id = _caller_id(call)
    if task_id is None:
        raise CliError("this folder is not the worktree of any card: only the session of a card can attach files")
    if args.name and len(args.files) > 1:
        raise CliError("--name names one file: pass one path, or none")
    secret = _hook_secret(task_id, Path.cwd())
    results = []
    for raw in args.files:
        path = Path(raw)
        if not path.is_file():
            raise CliError(f"{raw} is not a file")
        try:
            data = path.read_bytes()
        except OSError as e:
            raise CliError(f"cannot read {raw}: {e}")
        payload = {"name": args.name or path.name, "data": base64.b64encode(data).decode("ascii")}
        try:
            results.append(call("POST", f"/api/hooks/tasks/{task_id}/deliverables", payload, hook_secret=secret))
        except CliError as e:
            # A route the server does not have answers with the framework's bare text, not one of ours
            if str(e) == "Not Found":
                raise CliError(OLDER_SERVER.format(what="orc task attach"))
            raise
    return results


_DURATION = re.compile(r"(\d+)\s*([smhd])")
_UNIT_SEC = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_duration(raw: str) -> int:
    """`30m`, `2h`, `1h30m`, `1d` -> seconds. A bare number is minutes, the unit a person would mean."""
    text = raw.strip().lower()
    if text.isdigit():
        return int(text) * 60
    parts = _DURATION.findall(text)
    if not parts or _DURATION.sub("", text).strip():
        raise CliError(f"could not read the duration {raw!r}: use forms like 30m, 2h, 1h30m or 1d")
    return sum(int(number) * _UNIT_SEC[unit] for number, unit in parts)


def _cmd_wakeup(args: argparse.Namespace, call: Transport) -> Any:
    """Like `done`, speaks for the card of this session: sleep without a worker slot until a time or another card."""
    if args.at is not None and args.after is not None:
        raise CliError("--at and --in: pick one")
    if args.at is None and args.after is None and args.card is None:
        raise CliError("say when to wake: --in 30m, --at TIME, or --card N (with an optional --in as a deadline)")
    task_id = _caller_id(call)
    if task_id is None:
        raise CliError("this folder is not the worktree of any card: only the session of a card can ask for a wakeup")
    payload: dict = {"note": args.note or ""}
    if args.at is not None:
        payload["at"] = args.at
    if args.after is not None:
        payload["in_sec"] = parse_duration(args.after)
    if args.card is not None:
        payload["watch_task_id"] = _task_id(args.card, call)
    try:
        return call("POST", f"/api/hooks/tasks/{task_id}/wakeups", payload, hook_secret=_hook_secret(task_id, Path.cwd()))
    except CliError as e:
        if str(e) == "Not Found":  # the route itself is missing, not a card
            raise CliError("the server is older than this CLI and does not know wakeups: restart orc, or finish "
                           "the work in this turn and hand it in the way your prompt says") from e
        raise


def _cmd_context(args: argparse.Namespace, call: Transport) -> Any:
    query = {"cwd": os.getcwd(), **({"project": args.project} if args.project else {})}
    return call("GET", "/api/tasks/context?" + urllib.parse.urlencode(query), None)


def _print_context(ctx: dict) -> None:
    caller = ctx.get("caller")
    if caller:
        print(f"Your card: #{caller['id']} {caller['title']} (merges into {caller['target_branch']})")
    project = ctx.get("project")
    if not project:
        print("This folder belongs to no project, so pass --project. Projects:")
        for item in ctx["projects"]:
            print(f"  {item['name']} (#{item['id']}): {item['path']}")
        return
    print(f"Project: {project['name']} (#{project['id']}): {project['path']}")
    if project.get("problem"):
        print(f"Problem: {project['problem']}")
        return
    print(f"Base branch for new cards: {ctx['base_branch']}")
    print(f"Branches: {', '.join(ctx['branches'])}")
    print("Agents:" if ctx["agents"] else "Agents: none, cards run with the project's parameters")
    for agent in ctx["agents"]:
        params = ", ".join(str(agent[k]) for k in ("model", "effort", "permission_mode") if agent[k])
        print(f"  {agent['name']}" + (f" [{params}]" if params else "") + (f": {agent['description']}" if agent["description"] else ""))
    print("Open cards:" if ctx["tasks"] else "Open cards: none")
    for task in ctx["tasks"]:
        waits = ", ".join(f"#{d}" for d in task["depends_on"])
        print(f"  #{task['id']} [{task['status']}] {task['title']} (base {task['target_branch']}"
              + (f", waits for {waits}" if waits else "") + ")")


def _print_card(task: dict) -> None:
    waits = ", ".join(f"#{d}" for d in task["depends_on"])
    print(f"#{task['id']} [{task['status']}] {task['title']}"
          + (" (archived)" if task.get("archived_at") else ""))
    print(f"  project #{task['project_id']}, base {task['target_branch']}, priority {task['priority']}"
          + (f", waits for {waits}" if waits else "")
          + (f", subtask of #{task['parent_task_id']}" if task.get("parent_task_id") else "")
          + (f", stage {task['stage']}" if task.get("stage") else ""))
    params = ", ".join(f"{k} {task[k]}" for k in ("agent_id", "verify_cmd",
                                                  "start_after", "start_before") if task.get(k) is not None)
    if params:
        print(f"  {params.replace('agent_id', 'agent')}")
    plan = ", ".join(f"{k.replace('_', ' ')} {task[k]}" for k in ("start_date", "due_date") if task.get(k))
    if plan:
        print(f"  {plan}")
    if task.get("labels"):
        print(f"  labels: {', '.join(item['name'] for item in task['labels'])}")
    if task.get("blocker"):
        print(f"  blocked: {task['blocker']}" + (f" ({task['blocker_detail']})" if task.get("blocker_detail") else ""))
    if task.get("description"):
        print(f"\n{task['description']}")


def _print_list(result: dict) -> None:
    names = {int(k): v for k, v in result["projects"].items()}
    if not result["tasks"]:
        print("no cards")
    for t in result["tasks"]:
        waits = ", ".join(f"#{d}" for d in t["depends_on"])
        labels = ", ".join(item["name"] for item in t.get("labels") or [])
        print(f"#{t['id']} [{t['status']}] {t['title']}  ({names.get(t['project_id'], t['project_id'])}, base {t['target_branch']}"
              + (f", waits for {waits}" if waits else "") + (f", labels {labels}" if labels else "")
              + (f", due {t['due_date']}" if t.get("due_date") else "")
              + (", archived" if t.get("archived_at") else "") + ")")


def _print_result(args: argparse.Namespace, result: Any) -> None:
    if args.action in ("add", "batch"):
        _print_batch(result)
    elif args.action == "context":
        _print_context(result)
    elif args.action == "list":
        _print_list(result)
    elif args.action == "show":
        _print_card(result)
        for c in result.get("comments", []):
            print(f"\n[{c.get('author')}/{c.get('kind')}] {c.get('body')}")
    elif args.action == "link":
        waits = ", ".join(f"#{d}" for d in result["depends_on"]) or "nothing"
        print(f"#{result['id']} {result['title']} now waits for {waits}")
    elif args.action == "done":
        print(f"#{result['task_id']} handed in: verification and merge follow when this turn ends. Your final message "
              f"stands for the summary if you gave none.")
        if result["untracked"]:
            print(f"warning: untracked files stay out of the branch: {', '.join(result['untracked'][:30])}")
    elif args.action == "attach":
        for item in result:
            note = "already handed in unchanged, no new version" if item.get("duplicate") else "handed in"
            print(f"{item['name']} v{item['version']} ({item['size']} bytes): {note}")
    elif args.action == "fail":
        print(f"#{result['task_id']} will be marked as failed when this turn ends, and the owner sees your reason.")
    elif args.action == "wakeup":
        print(f"#{result['task_id']} will sleep {result['summary']} once this turn ends, without holding a worker slot. "
              f"End your turn now with a short message; the session resumes here with the reason when it wakes.")
    elif args.action == "delete":
        parts = [name for name in ("session", "worktree", "branch") if result.get(name)]
        print(f"#{result['deleted']} deleted" + (f" together with its {', '.join(parts)}" if parts else ""))
        if result.get("dependents"):
            print(f"note: {', '.join(f'#{d}' for d in result['dependents'])} waited for it and no longer do")
    else:  # edit, move, archive, unarchive: the card as it is now
        verb = {"edit": "updated", "move": "moved", "archive": "archived", "unarchive": "restored"}[args.action]
        print(f"#{result['id']} {verb}")
        _print_card(result)
        for warning in result.get("warnings", []):
            print(f"note: {warning}")
        if result.get("note"):
            print(f"note: {result['note']}")


def add_parser(sub: argparse._SubParsersAction) -> None:
    task = sub.add_parser("task", help="create, read, change, move and remove cards on the board, for agents and scripts")
    actions = task.add_subparsers(dest="action", required=True)

    def common(parser: argparse.ArgumentParser) -> None:
        parser.add_argument("--project", help="name, id or path; by default the project of the current folder")
        parser.add_argument("--no-dedupe", action="store_true", help="create new cards even if this exact request was just made")
        parser.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    add = actions.add_parser("add", help="create one card")
    add.add_argument("title")
    add.add_argument("--description", help="the assignment; a card in To do must have one")
    add.add_argument("--description-file", help="read the assignment from a file, - for stdin")
    add.add_argument("--after", action="append", metavar="ID", help="wait for this card (a number or current); repeatable")
    add.add_argument("--base", help="base branch; by default the blocker's, then the current card's, then the project's")
    add.add_argument("--base-from", metavar="BRANCH", help="create the --base branch from this one if it does not exist")
    add.add_argument("--status", choices=("backlog", "todo"), help="backlog by default: the owner decides when it runs")
    add.add_argument("--priority", choices=("high", "normal", "low"))
    add.add_argument("--agent", help="the name of an agent: see `orc task context`")
    add.add_argument("--verify-cmd", dest="verify_cmd")
    add.add_argument("--start-after", dest="start_after", help="do not start earlier: ISO 8601 with a time zone")
    add.add_argument("--start-before", dest="start_before", help="do not start later: ISO 8601 with a time zone")
    add.add_argument("--start-date", dest="start_date", metavar="YYYY-MM-DD", help="planned first day; the queue ignores it")
    add.add_argument("--due-date", dest="due_date", metavar="YYYY-MM-DD", help="planned last day; the queue ignores it")
    add.add_argument("--label", action="append", metavar="NAME", help="a label, created if missing; repeatable")
    parent = add.add_mutually_exclusive_group()
    parent.add_argument("--parent", metavar="ID", help="make it a subtask of this card (a number or current); "
                                                      "by default a subtask of the card this command runs in")
    parent.add_argument("--no-parent", dest="no_parent", action="store_true",
                        help="a top-level card, even when created from a card's session")
    add.add_argument("--stage", type=int, metavar="N", help="the stage among the subtasks of the parent: it starts when the "
                                                            "previous stage is done; needs a parent")
    common(add)

    batch = actions.add_parser("batch", help="create several linked cards from a JSON plan, all or none")
    batch.add_argument("file", help="the plan file, - for stdin. Format: orc task guide")
    common(batch)

    link = actions.add_parser("link", help="add or remove blockers of a card that has not started")
    link.add_argument("task", help="a card number or current")
    link.add_argument("--after", action="append", metavar="ID", help="add this blocker (a number or current); repeatable")
    link.add_argument("--remove", action="append", type=int, metavar="ID", help="remove this blocker; repeatable")
    link.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    context = actions.add_parser("context", help="where you stand: project, base branch, agents, open cards")
    context.add_argument("--project", help="name, id or path; by default the project of the current folder")
    context.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    show = actions.add_parser("show", help="one card in full: description, parameters, comments")
    show.add_argument("task", help="a card number or current")
    show.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    listing = actions.add_parser("list", help="cards of a project, or of all projects")
    listing.add_argument("--project", help="name, id or path; by default the project of the current folder, else all")
    listing.add_argument("--status", choices=("backlog", "todo", "in_progress", "verifying", "merging", "done", "failed"))
    listing.add_argument("--archived", choices=("hide", "only", "all"), default="hide")
    listing.add_argument("--label", metavar="NAME", help="only cards with this label")
    listing.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    edit = actions.add_parser("edit", help="change any field of a card; only the fields you pass change")
    edit.add_argument("task", help="a card number or current")
    edit.add_argument("--title")
    edit.add_argument("--description", help="the new assignment")
    edit.add_argument("--description-file", help="read the new assignment from a file, - for stdin")
    edit.add_argument("--status", choices=("backlog", "todo", "done"),
                      help="move the card; done closes it without verification and merge and needs --force")
    edit.add_argument("--force", action="store_true", help="confirm closing a card by hand")
    edit.add_argument("--priority", choices=("high", "normal", "low"))
    edit.add_argument("--agent", help="the name of an agent of the card's project")
    edit.add_argument("--verify-cmd", dest="verify_cmd")
    edit.add_argument("--base", help="base branch; only while the card has not started")
    edit.add_argument("--start-after", dest="start_after", help="ISO 8601 with a time zone")
    edit.add_argument("--start-before", dest="start_before", help="ISO 8601 with a time zone")
    edit.add_argument("--start-date", dest="start_date", metavar="YYYY-MM-DD", help="planned first day; the queue ignores it")
    edit.add_argument("--due-date", dest="due_date", metavar="YYYY-MM-DD", help="planned last day; the queue ignores it")
    edit.add_argument("--label", action="append", metavar="NAME", help="add a label, created if missing; repeatable")
    edit.add_argument("--remove-label", action="append", metavar="NAME", help="take a label off; repeatable")
    edit.add_argument("--parent", metavar="ID", help="make it a subtask of this card (a number or current); --clear parent undoes it")
    wake = edit.add_mutually_exclusive_group()
    wake.add_argument("--wake-on-children", dest="wake_on_children", action="store_true",
                      help="wake this card when all its subtasks are done; --clear wake_on_children follows the project again")
    wake.add_argument("--no-wake-on-children", dest="no_wake_on_children", action="store_true",
                      help="never wake this card when its subtasks are done")
    edit.add_argument("--stage", type=int, metavar="N", help="the stage among the subtasks of its parent; --clear stage undoes it")
    edit.add_argument("--clear", action="append", choices=CLEARABLE,
                      help="remove this value, so the agent or the project's parameters apply again; repeatable")
    edit.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    move = actions.add_parser("move", help="move a card that has not started to another project")
    move.add_argument("task", help="a card number or current")
    move.add_argument("--to", required=True, metavar="PROJECT", help="name, id or path of the project to move to")
    move.add_argument("--base", help="base branch in the new project; by default the blockers', then the project's")
    move.add_argument("--agent", help="an agent of the new project; by default the card's own if it fits there")
    move.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    for name, text in (("archive", "take a card off the board; undo it with unarchive"),
                       ("unarchive", "bring an archived card back, with the status it left in")):
        archiver = actions.add_parser(name, help=text)
        archiver.add_argument("task", help="a card number or current")
        archiver.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    delete = actions.add_parser("delete", help="delete a card for good, with its worktree and branch (prefer archive)")
    delete.add_argument("task", help="a card number")
    delete.add_argument("--yes", action="store_true", help="confirm: deletion cannot be undone")
    delete.add_argument("--force", action="store_true", help="delete a card that is being worked on, cutting its session off")
    delete.add_argument("--keep-worktree", action="store_true", help="keep the branch and the working copy")
    delete.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    done = actions.add_parser("done", help="hand in the card this session works on, as the last action of the work")
    done.add_argument("--summary", help="what was done; by default your final message")
    done.add_argument("--summary-file", help="read the summary from a file, - for stdin")
    done.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    fail = actions.add_parser("fail", help="say that the card this session works on cannot be completed")
    fail.add_argument("--reason", required=True, help="why, and what decision the owner has to make")
    fail.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    attach = actions.add_parser("attach", help="hand in files as the result of the card this session works on")
    attach.add_argument("files", nargs="+", metavar="FILE", help="a report, screenshot, archive; the same name again is a new version")
    attach.add_argument("--name", help="the name to show on the card, if not the file's own")
    attach.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    wakeup = actions.add_parser("wakeup", help="sleep without a worker slot until a time or another card, as the last "
                                               "action of a turn; the session resumes then")
    wakeup.add_argument("--in", dest="after", metavar="DURATION", help="wake after this long: 30m, 2h, 1h30m, 1d")
    wakeup.add_argument("--at", help="wake at this time, ISO 8601 with a time zone")
    wakeup.add_argument("--card", metavar="ID", help="wake when this card is done, fails or goes away; with --in or "
                                                     "--at, whichever comes first")
    wakeup.add_argument("--note", help="what to do on waking; given back to you then")
    wakeup.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    actions.add_parser("guide", help="how to create cards and decompose a feature")

    skill = actions.add_parser("install-skill", help="teach Claude Code sessions outside orc about this command")
    skill.add_argument("--dir", help="the skills directory, ~/.claude/skills by default")
    skill.add_argument("--force", action="store_true", help="overwrite a file orc did not write")


def run(args: argparse.Namespace, call: Transport | None = None) -> int:
    directory = data_dir()
    try:
        if args.action == "guide":
            print(task_guide.guide(directory))
            return 0
        if args.action == "install-skill":
            target = Path(args.dir).expanduser() if args.dir else Path.home() / ".claude" / "skills"
            try:
                print(f"installed: {task_guide.install_skill(directory, target, force=args.force)}")
            except FileExistsError as e:
                raise CliError(str(e))
            return 0
        call = call or http_transport(directory)
        handlers = {"add": _cmd_add, "batch": _cmd_batch, "link": _cmd_link, "context": _cmd_context,
                    "show": _cmd_show, "list": _cmd_list, "edit": _cmd_edit, "move": _cmd_move,
                    "archive": _cmd_archive, "unarchive": _cmd_archive, "delete": _cmd_delete,
                    "done": _cmd_handoff, "fail": _cmd_handoff, "attach": _cmd_attach, "wakeup": _cmd_wakeup}
        result = handlers[args.action](args, call)
    except CliError as e:
        print(f"orc task {args.action}: {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        _print_result(args, result)
    return 0
