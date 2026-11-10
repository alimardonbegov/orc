"""What a task card shows and what a new card starts with, set for all of orc or for one project.

The properties themselves live in the dashboard's registry (web/src/components/cardProperties): the
server stores a choice about them and never needs a list of them, so adding a property takes no
migration and no change here. A project overrides key by key: a key it does not hold follows orc.

    {"hidden": ["priority"], "default_agent_id": 3, "default_priority": "normal",
     "quick_actions": [{"id": "review", "title": "Review", "prompt": "Review the changes."}]}

Quick actions are canned messages for the agent, shown on the card and under "/" in its composer.
A key that is absent means the dashboard's built-in set; an empty list means none. A project that
holds the key replaces the whole list.

Defaults fill the creation form. A card created through the API or the CLI gets what the request
says, so a default set in the dashboard cannot silently change a script. The one exception is a card
a session sends straight to the queue without naming an agent: see default_agent.
"""
from __future__ import annotations

import json
from typing import Any

from orc.models import Priority, Project

HIDDEN = "hidden"
DEFAULT_AGENT = "default_agent_id"
DEFAULT_PRIORITY = "default_priority"
# Waking a parent card when its subtasks are done (orc/child_wake.py): off unless set, and the text it is woken with
WAKE_PARENT = "wake_parent"
WAKE_PARENT_INSTRUCTION = "wake_parent_instruction"
QUICK_ACTIONS = "quick_actions"
KEYS = (HIDDEN, DEFAULT_AGENT, DEFAULT_PRIORITY, QUICK_ACTIONS, WAKE_PARENT, WAKE_PARENT_INSTRUCTION)
MAX_QUICK_ACTIONS = 30
MAX_ACTION_TITLE = 60
MAX_ACTION_PROMPT = 4000


def _quick_actions(raw: Any) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > MAX_QUICK_ACTIONS:
        raise ValueError(f"{QUICK_ACTIONS}: a list of at most {MAX_QUICK_ACTIONS} actions is expected")
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"id", "title", "prompt"}:
            raise ValueError(f"{QUICK_ACTIONS}: every action holds id, title and prompt")
        fields = {}
        for key in ("id", "title", "prompt"):
            if not isinstance(item[key], str) or not item[key].strip():
                raise ValueError(f"{QUICK_ACTIONS}: {key} must be a non-empty string")
            fields[key] = item[key].strip()
        if len(fields["title"]) > MAX_ACTION_TITLE or len(fields["prompt"]) > MAX_ACTION_PROMPT:
            raise ValueError(f"{QUICK_ACTIONS}: title or prompt is too long")
        if any(fields["id"] == seen["id"] for seen in out):
            raise ValueError(f"{QUICK_ACTIONS}: duplicate id {fields['id']!r}")
        out.append(fields)
    return out


def normalize(raw: Any) -> dict:
    """A settings object with known keys and checked values. ValueError names what is wrong."""
    if not isinstance(raw, dict):
        raise ValueError("an object is expected")
    unknown = sorted(set(raw) - set(KEYS))
    if unknown:
        raise ValueError(f"unknown keys: {unknown}")
    out: dict = {}
    if HIDDEN in raw:
        hidden = raw[HIDDEN]
        if not isinstance(hidden, list) or not all(isinstance(item, str) and item.strip() for item in hidden):
            raise ValueError(f"{HIDDEN}: a list of property ids is expected")
        out[HIDDEN] = list(dict.fromkeys(item.strip() for item in hidden))
    if DEFAULT_AGENT in raw:
        agent = raw[DEFAULT_AGENT]
        # bool is an int in Python, and true would read as the agent number 1
        if agent is not None and (isinstance(agent, bool) or not isinstance(agent, int)):
            raise ValueError(f"{DEFAULT_AGENT}: an agent id or null is expected")
        out[DEFAULT_AGENT] = agent
    if DEFAULT_PRIORITY in raw:
        if raw[DEFAULT_PRIORITY] not in tuple(Priority):
            raise ValueError(f"{DEFAULT_PRIORITY}: expected one of {[p.value for p in Priority]}")
        out[DEFAULT_PRIORITY] = str(raw[DEFAULT_PRIORITY])
    if WAKE_PARENT in raw:
        if not isinstance(raw[WAKE_PARENT], bool):
            raise ValueError(f"{WAKE_PARENT}: true or false is expected")
        out[WAKE_PARENT] = raw[WAKE_PARENT]
    if WAKE_PARENT_INSTRUCTION in raw:
        text = raw[WAKE_PARENT_INSTRUCTION]
        if not isinstance(text, str) or len(text) > 4000:
            raise ValueError(f"{WAKE_PARENT_INSTRUCTION}: a text of at most 4000 characters is expected")
        out[WAKE_PARENT_INSTRUCTION] = text.strip()
    if QUICK_ACTIONS in raw:
        out[QUICK_ACTIONS] = _quick_actions(raw[QUICK_ACTIONS])
    return out


def dumps(settings: dict) -> str:
    # Compact, like JSON.stringify in the dashboard: the settings window compares strings to see what changed
    return json.dumps(settings, separators=(",", ":"))


def parse(raw: str | None) -> dict | None:
    """The stored value going out. A broken one (hand-edited database) reads as nothing of its own:
    the whole project list must not fail because of it."""
    if raw is None:
        return None
    try:
        return normalize(json.loads(raw))
    except ValueError:
        return None


def default_agent(repo, project: Project) -> int | None:
    """The agent a new card of this project starts with: the project's choice, otherwise orc's. A choice
    that no longer fits (the agent was deleted or moved to another project) counts as none."""
    own = parse(project.card_settings) or {}
    shared = parse(repo.get_setting("card_settings")) or {}
    agent_id = own[DEFAULT_AGENT] if DEFAULT_AGENT in own else shared.get(DEFAULT_AGENT)
    if agent_id is None:
        return None
    agent = repo.get_agent(agent_id)
    return agent_id if agent is not None and agent.project_id in (None, project.id) else None
