"""Input requests from a session: tool permissions, AskUserQuestion questions, plan approval.

Only pure functions without side effects live here: the dictionary of request kinds, the badge summary,
parsing of the `needs` field from state.json and hook settings for `claude --settings`. The flow itself,
hook -> API -> card -> decision -> hook, is described in docs/internals/input-requests.md; state lives in
the input_requests table (orc/repo.py), transitions are made by the Dispatcher.
"""
from __future__ import annotations

import json
import os
import shlex
import sys
from pathlib import Path

HOOK_SCRIPT = Path(__file__).parent / "hooks" / "input_hook.py"
# The hook holds the tool until the owner answers, and they may answer even hours later.
# The ceiling is only needed so the session does not hang forever if orc died together with the database.
HOOK_TIMEOUT_SEC = 24 * 3600

# The task secret for its hooks. A file, not an argument: the hook command line sits in the
# session's `--settings` (argv of the claude process, saved session options) and is visible through ps
# to anyone, while a file with 0600 permissions in the task working copy is visible only to the owner.
HOOK_SECRET_REL_PATH = ".orchestrator/hook-secret"


def write_hook_secret(worktree: Path, secret: str) -> Path:
    """Write the secret into the task working copy with 0600 permissions. Returns the file path."""
    path = Path(worktree) / HOOK_SECRET_REL_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(secret)
    os.chmod(path, 0o600)  # the file may have been left over from a previous version with different permissions
    return path

KIND_PERMISSION = "permission"
KIND_QUESTION = "question"
KIND_PLAN = "plan"
KINDS = {KIND_PERMISSION, KIND_QUESTION, KIND_PLAN}

# Tools whose call by itself means "a human is needed". Permissions for the rest
# arrive as a separate PermissionRequest event, not through PreToolUse.
INTERACTIVE_TOOLS = {"AskUserQuestion": KIND_QUESTION, "ExitPlanMode": KIND_PLAN}

# How to name the wait on the card and in the feed, by request kind.
KIND_LABEL = {
    KIND_PERMISSION: "is waiting for permission",
    KIND_QUESTION: "is waiting for reply",
    KIND_PLAN: "is waiting for plan approval",
}


def kind_for(hook_event: str, tool_name: str) -> str | None:
    """Request kind from the hook event and tool. None means the event is not about human input."""
    if hook_event == "PermissionRequest":
        return KIND_PERMISSION
    if hook_event == "PreToolUse":
        return INTERACTIVE_TOOLS.get(tool_name)
    return None


def shorten(text: str, limit: int = 300, keep_lines: bool = False) -> str:
    """Truncate text to `limit` characters. By default to a single line (for the feed and badge);
    `keep_lines` keeps line breaks so the agent's multi-line text reads well on the card."""
    text = text.strip() if keep_lines else " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def summarize(kind: str, tool_name: str, tool_input: dict) -> str:
    """A single line about the request, for blocker_detail, the event feed and old clients."""
    if kind == KIND_QUESTION:
        questions = tool_input.get("questions") or []
        parts = []
        for q in questions:
            if not isinstance(q, dict):
                continue
            labels = [o.get("label", "") for o in q.get("options") or [] if isinstance(o, dict)]
            text = str(q.get("question", ""))
            parts.append(f"{text} ({' · '.join(labels)})" if labels else text)
        return shorten("Asks: " + "; ".join(parts)) if parts else "Asks (question without text)"
    if kind == KIND_PLAN:
        return "Waiting for plan approval"
    return shorten(f"Requests permission: {tool_name} — {describe_tool_input(tool_name, tool_input)}")


def describe_tool_input(tool_name: str, tool_input: dict) -> str:
    """The most essential part of the tool input: command, path, query, whatever is there."""
    for key in ("command", "file_path", "path", "pattern", "url", "query", "prompt", "description"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    try:
        return json.dumps(tool_input, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(tool_input)


def describe_needs(needs: str | None, detail: str | None = None) -> str:
    """Translate the `needs` field from state.json into card text.

    The daemon writes it in three forms (spikes of 2026-09-21, Claude Code 2.1.278):
    "approve Bash: <command>", "answer: <question> (<option> · <option>)", "approve plan".
    This is a fallback channel: normally the request arrives through the hook with all fields, and we end up here
    when the hook did not fire (orc was unavailable, an old session without hooks).
    """
    text = (needs or "").strip()
    if not text:
        return (detail or "").strip() or "session is waiting for input"
    if text == "approve plan":
        return "Waiting for plan approval"
    if text.startswith("approve "):
        return "Requests permission: " + text.removeprefix("approve ")
    if text.startswith("answer:"):
        return "Asks: " + text.removeprefix("answer:").strip()
    return text


def kind_from_needs(needs: str | None) -> str | None:
    """Wait kind from the `needs` text, so that the fallback channel badge matches the main one."""
    text = (needs or "").strip()
    if text == "approve plan":
        return KIND_PLAN
    if text.startswith("approve "):
        return KIND_PERMISSION
    if text.startswith("answer:"):
        return KIND_QUESTION
    return None


def hook_settings(api_base: str, task_id: int, secret_path: str | None = None,
                  python: str | None = None) -> dict:
    """`hooks` entries for `claude --settings`: PermissionRequest for everything and PreToolUse for
    interactive tools. The API address, task number and secret path go as arguments of the
    command: the hook knows nothing about the orc database and must not guess it. This is the only place
    where the hook command line is assembled."""
    command = f"{python or sys.executable} {HOOK_SCRIPT} --api {api_base} --task {task_id}"
    if secret_path:
        command += f" --secret-file {shlex.quote(secret_path)}"
    hook = {"type": "command", "command": command, "timeout": HOOK_TIMEOUT_SEC}
    return {
        "PermissionRequest": [{"matcher": "*", "hooks": [hook]}],
        "PreToolUse": [{"matcher": "|".join(sorted(INTERACTIVE_TOOLS)), "hooks": [hook]}],
    }


def validate_decision(kind: str, tool_input: dict, decision: dict) -> dict:
    """Validate the owner's decision and return it in canonical form. ValueError carries the text for a 400."""
    if not isinstance(decision, dict):
        raise ValueError("decision must be an object")
    if kind == KIND_QUESTION:
        answers = decision.get("answers")
        if not isinstance(answers, dict) or not answers:
            raise ValueError("a question needs an answers object: {question text: answer}")
        questions = [str(q.get("question", "")) for q in tool_input.get("questions") or [] if isinstance(q, dict)]
        clean: dict[str, str] = {}
        for question in questions:
            answer = answers.get(question)
            if not isinstance(answer, str) or not answer.strip():
                raise ValueError(f"no answer for question: {question!r}")
            clean[question] = answer.strip()
        return {"answers": clean}
    behavior = decision.get("behavior")
    if behavior not in ("allow", "deny"):
        raise ValueError("behavior: allow | deny")
    message = decision.get("message")
    if message is not None and not isinstance(message, str):
        raise ValueError("message must be a string")
    clean = {"behavior": behavior}
    if message and message.strip():
        clean["message"] = message.strip()
    if kind == KIND_PERMISSION:
        scope = decision.get("scope", "once")
        if scope not in ("once", "session"):
            raise ValueError("scope: once | session")
        if behavior == "allow":
            clean["scope"] = scope
    return clean


def decision_text(kind: str, tool_name: str, tool_input: dict, decision: dict) -> str:
    """The decision in words, for the card conversation, so it is visible what was answered and when."""
    if kind == KIND_QUESTION:
        return "\n".join(f"{q} → {a}" for q, a in decision["answers"].items())
    message = decision.get("message")
    if kind == KIND_PLAN:
        head = "Plan approved" if decision["behavior"] == "allow" else "Plan not approved"
        return f"{head}: {message}" if message else head
    what = f"{tool_name} — {describe_tool_input(tool_name, tool_input)}"
    if decision["behavior"] == "allow":
        head = "Allowed until the end of the session" if decision.get("scope") == "session" else "Allowed"
    else:
        head = "Rejected"
    text = f"{head}: {what}"
    return f"{text}\n{message}" if message else text
