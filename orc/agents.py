"""Agents: pre-configured executors that tasks, routines and chats are allocated to.

An agent is a named set of run parameters (model, effort, permission mode) plus an optional prompt.
It holds no process and no conversation: a session is still started per task, and the agent only
decides how. See docs/internals/agents.md.

Parameters are read when a session starts, not copied into the task, so a task that has not started
yet follows an edited agent, just as it follows an edited project. A running session keeps what it was
started with.
"""
from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from orc.models import Agent, Project, Task

DEFAULT_PERMISSION_MODE = "auto"
# A memory file is shown in the UI, not edited there: a long one is cut rather than sent whole on every open.
MEMORY_PREVIEW_CHARS = 20_000


@dataclass(frozen=True)
class RunParams:
    model: str | None
    effort: str | None
    permission_mode: str


def resolve_params(task: Task | None, agent: Agent | None, project: Project | None) -> RunParams:
    """What a session runs with: the agent's value, then the project's.

    A card holds no run parameters of its own: it is tied to its agent, and the agent decides how the
    work runs. The `task` argument is kept for callers that pass the card, but nothing is read from it,
    so a value left in an old row (the columns are no longer written) cannot change a run.

    The project lead is deliberately not a step here: a lead coordinates and does not configure the
    other executors, so appointing one must not change what the project's tasks run on.
    """
    def pick(agent_field: str, project_field: str):
        return ((getattr(agent, agent_field) if agent else None)
                or (getattr(project, project_field) if project else None))

    return RunParams(
        model=pick("model", "default_model"),
        effort=pick("effort", "default_effort"),
        permission_mode=pick("permission_mode", "default_permission_mode") or DEFAULT_PERMISSION_MODE,
    )


def system_prompt(agent: Agent | None) -> str | None:
    """The text for `--append-system-prompt`: who the agent is and what the owner wrote for it.

    A system prompt rather than a CLAUDE.md in the worktree: that file is tracked in the owner's
    repository and would land in the merge. The agent's name goes first, which also keeps the value
    from starting with a dash and being read as a CLI option.
    """
    if agent is None:
        return None
    lines = [f"You are working as the agent \"{agent.name}\" of this orchestrator."]
    if agent.description.strip():
        lines.append(f"Your role: {agent.description.strip()}")
    if agent.prompt.strip():
        lines += ["", agent.prompt.strip()]
    return "\n".join(lines)


def memory_dir(data_dir: Path, agent_id: int) -> Path:
    return Path(data_dir).resolve() / "agents" / str(agent_id) / "memory"


def memory_settings(data_dir: Path, agent: Agent | None) -> dict:
    """A piece of `claude --settings` that gives the agent its own memory.

    Claude Code's auto memory lives per repository. `autoMemoryDirectory` points it at a folder of
    this agent instead, so what the agent learns follows it across projects, and it stops seeing the
    repository's shared auto memory in these sessions. Hence opt-in: a shared agent carries facts from
    one project into another. An agent without the flag behaves like any other session.
    """
    if agent is None or not agent.memory_enabled:
        return {}
    path = memory_dir(data_dir, agent.id)
    path.mkdir(parents=True, exist_ok=True)
    return {"autoMemoryDirectory": str(path)}


def read_memory(data_dir: Path, agent_id: int) -> list[dict]:
    """The agent's memory files for the UI. Written by the sessions themselves, so shown as data."""
    root = memory_dir(data_dir, agent_id)
    if not root.is_dir():
        return []
    out = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        out.append({"name": str(path.relative_to(root)), "size": path.stat().st_size,
                    "content": text[:MEMORY_PREVIEW_CHARS], "truncated": len(text) > MEMORY_PREVIEW_CHARS})
    return out


def clear_memory(data_dir: Path, agent_id: int) -> None:
    shutil.rmtree(memory_dir(data_dir, agent_id), ignore_errors=True)
