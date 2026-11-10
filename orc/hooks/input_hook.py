#!/usr/bin/env python3
"""Input request hook: passes the session's question to orc and holds the tool until the owner answers.

Claude Code launches it on two events:
- `PermissionRequest`: the session asks for permission to use a tool;
- `PreToolUse` for AskUserQuestion and ExitPlanMode: a question with options and plan approval.

In a background session nobody is there to answer such a dialog, and without the hook it silently stalls. Instead the hook
registers the request in orc (`POST /api/hooks/input-requests`), polls for its decision and
returns the answer to Claude Code in the hook's own format: allow/deny for a permission, `updatedInput`
with `answers` for a question. The session is neither stopped nor resumed, so there are no copies.

Stdlib only and no imports from orc: the script works from any environment where python is available.
Any error is a silent exit with no output: then Claude Code shows its usual dialog, and
the dispatcher sees the wait through the fallback channel (tempo/needs in state.json).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

POLL_SEC = 2.0
# How long we tolerate a non-responding server in a row before giving up: an orc restart takes
# seconds, not minutes, and waiting longer is pointless: the request most likely no longer exists.
UNREACHABLE_LIMIT_SEC = 120


def _read_secret(path: str | None) -> str | None:
    """Secret from a file next to the working copy. No file: go without a secret, but the server will reject such a
    request (403): hook endpoints require X-Orc-Hook."""
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def _http(method: str, url: str, body: dict | None = None, timeout: float = 10,
          secret: str | None = None) -> dict:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    headers = {"content-type": "application/json"}
    if secret:
        headers["x-orc-hook"] = secret
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def kind_for(hook_event: str, tool_name: str) -> str | None:
    if hook_event == "PermissionRequest":
        return "permission"
    if hook_event == "PreToolUse":
        return {"AskUserQuestion": "question", "ExitPlanMode": "plan"}.get(tool_name)
    return None


def build_output(kind: str, data: dict, decision: dict) -> dict | None:
    """Hook response for the owner's decision. None means no decision, let Claude Code ask itself."""
    tool_input = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    if kind == "permission":
        if decision.get("behavior") == "allow":
            body: dict = {"behavior": "allow", "updatedInput": tool_input}
            if decision.get("scope") == "session":
                # Stop asking about this tool until the end of the session: the rule covers the whole
                # tool, only in session memory: we write nothing to the project settings.
                body["updatedPermissions"] = [{
                    "type": "addRules", "behavior": "allow", "destination": "session",
                    "rules": [{"toolName": str(data.get("tool_name") or "")}],
                }]
            return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": body}}
        if decision.get("behavior") == "deny":
            body = {"behavior": "deny", "message": decision.get("message") or "The task owner rejected the action"}
            return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": body}}
        return None
    if kind == "question":
        answers = decision.get("answers")
        if not isinstance(answers, dict):
            return None
        # AskUserQuestion format: the original questions plus answers {question text: answer}.
        # A free-form answer goes in the same string, just like "Other" in the terminal.
        updated = {**tool_input, "answers": answers}
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": updated,
        }}
    if kind == "plan":
        if decision.get("behavior") == "allow":
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": tool_input,
            }}
        if decision.get("behavior") == "deny":
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse", "permissionDecision": "deny",
                "permissionDecisionReason": decision.get("message") or "The task owner did not approve the plan",
            }}
    return None


def wait_decision(api: str, request_id: int, secret: str | None = None, prefix: str = "input-requests") -> dict | None:
    """Poll the request while it is open. None means the request was closed without a decision or orc is gone."""
    unreachable_since: float | None = None
    while True:
        try:
            row = _http("GET", f"{api}/api/hooks/{prefix}/{request_id}", secret=secret)
            unreachable_since = None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            row = None
        except (urllib.error.URLError, OSError, ValueError):
            row = None
        if row is None:
            unreachable_since = unreachable_since or time.monotonic()
            if time.monotonic() - unreachable_since > UNREACHABLE_LIMIT_SEC:
                return None
            time.sleep(POLL_SEC)
            continue
        state = row.get("state")
        if state == "answered":
            decision = row.get("decision")
            return decision if isinstance(decision, dict) else None
        if state != "open":
            return None
        time.sleep(POLL_SEC)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", required=True)
    owner = parser.add_mutually_exclusive_group(required=True)
    owner.add_argument("--task", type=int)
    owner.add_argument("--chat", type=int)
    parser.add_argument("--secret-file")
    args = parser.parse_args()
    secret = _read_secret(args.secret_file)
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    if not isinstance(data, dict):
        return 0
    tool_name = str(data.get("tool_name") or "")
    kind = kind_for(str(data.get("hook_event_name") or ""), tool_name)
    if kind is None:
        return 0
    tool_input = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    # A chat has its own pair of endpoints: its requests live among the chat's messages, not on a card
    prefix = "chat-input-requests" if args.chat is not None else "input-requests"
    owner_field = {"chat_id": args.chat} if args.chat is not None else {"task_id": args.task}
    try:
        created = _http("POST", f"{args.api}/api/hooks/{prefix}", {
            **owner_field,
            "session_id": data.get("session_id"),
            "cwd": data.get("cwd"),
            "kind": kind,
            "tool_name": tool_name,
            "tool_input": tool_input,
        }, secret=secret)
    except (urllib.error.URLError, OSError, ValueError):
        # orc is unavailable or refused (the task is no longer in progress): Claude Code itself will show the dialog.
        return 0
    request_id = created.get("id")
    if not isinstance(request_id, int):
        return 0
    decision = wait_decision(args.api, request_id, secret=secret, prefix=prefix)
    if decision is None:
        return 0
    output = build_output(kind, {**data, "tool_input": tool_input}, decision)
    if output is not None:
        print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # The hook has no right to crash the session because of its own error.
        sys.exit(0)
