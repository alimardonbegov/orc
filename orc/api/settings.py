"""The /settings, /usage*, /events* and /dispatcher* endpoints."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request

from orc import usage
from orc.api.common import SETTING_KEYS, _check_settings, _dispatcher, _repo, hidden_models_json
from orc.dispatcher import WORKTREE_RETENTION_DAYS
from orc.prompt import CONFLICT_TEMPLATE, DEFAULT_TEMPLATE
from orc.quota import DEFAULT_QUOTA_PATTERNS

router = APIRouter()


@router.get("/events")
def list_events(request: Request, unread: int = 0):
    return _repo(request).list_events(unread_only=bool(unread))


@router.post("/events/read")
def read_events(request: Request):
    _repo(request).mark_events_read()
    return {"ok": True}


@router.get("/settings")
def get_settings(request: Request):
    repo = _repo(request)
    return {
        "global_max_workers": repo.get_setting("global_max_workers", "3"),
        "poll_interval_sec": repo.get_setting("poll_interval_sec", "30"),
        "prompt_template": repo.get_setting("prompt_template") or DEFAULT_TEMPLATE,
        "quota_patterns": repo.get_setting("quota_patterns") or json.dumps(DEFAULT_QUOTA_PATTERNS),
        # Resolve a conflict with the target branch using the task's own session rather than calling the human right away
        "conflict_autoresolve": repo.get_setting("conflict_autoresolve", "1"),
        "conflict_prompt_template": repo.get_setting("conflict_prompt_template") or CONFLICT_TEMPLATE,
        "verify_workers": repo.get_setting("verify_workers", "2"),
        "events_retention_days": repo.get_setting("events_retention_days", "30"),
        "attachments_max_total_mb": repo.get_setting("attachments_max_total_mb", "500"),
        # Clean up working copies of merged tasks after N days (orc/worktrees.py:autoclean)
        "worktree_autoclean": repo.get_setting("worktree_autoclean", "1"),
        "worktree_retention_days": repo.get_setting("worktree_retention_days", str(WORKTREE_RETENTION_DAYS)),
        # Models hidden from the model-selection dropdowns in all projects (JSON list of ids).
        # A project can set its own list on top of this (projects.hidden_models).
        "hidden_models": repo.get_setting("hidden_models", "[]"),
    }


@router.patch("/settings")
def patch_settings(body: dict[str, str], request: Request):
    repo = _repo(request)
    unknown = set(body) - SETTING_KEYS
    if unknown:
        raise HTTPException(400, f"unknown settings: {sorted(unknown)}")
    _check_settings(body)
    if "hidden_models" in body:
        # Stored already normalized: no duplicates or empty ids, so the comparison in the dashboard is honest
        body = {**body, "hidden_models": hidden_models_json(json.loads(body["hidden_models"]))}
    for k, v in body.items():
        repo.set_setting(k, v)
    return get_settings(request)


@router.get("/usage")
def get_usage(request: Request):
    """Account limits from the orchestrator cache (orc/usage.py).

    If the numbers are stale, we also ask for new ones, but in the background and no more often than the probe cooldown: the board's
    response must not wait several seconds for numbers that change over minutes.
    """
    settings = request.app.state.settings
    status = usage.read(settings.usage_cache_path, settings.claude_json_path)
    if status["stale"]:
        request.app.state.prober.refresh_async()
    return status


@router.post("/usage/refresh")
def refresh_usage(request: Request):
    """Ask Claude for the limits right now: this is the "refresh" button.

    The probe is a real request to the model, so it has its own short cooldown: frequent presses
    just return what is already in the cache.
    """
    settings = request.app.state.settings
    # wait: if a background poll is already running, wait for ITS answer instead of returning to the human
    # exactly the stale numbers that made them press the button.
    request.app.state.prober.refresh(usage.PROBE_MANUAL_COOLDOWN_SEC, wait=usage.PROBE_WAIT_SEC)
    return usage.read(settings.usage_cache_path, settings.claude_json_path)


@router.get("/dispatcher")
def dispatcher_status(request: Request):
    return _dispatcher(request).status()


@router.post("/dispatcher/pause")
def dispatcher_pause(request: Request):
    _repo(request).set_setting("dispatcher_paused", "1")
    return _dispatcher(request).status()


@router.post("/dispatcher/resume")
def dispatcher_resume(request: Request):
    _repo(request).set_setting("dispatcher_paused", "0")
    return _dispatcher(request).status()


@router.post("/dispatcher/tick")
def dispatcher_tick(request: Request):
    # Non-blocking acquire: while a background-thread pass is running, a second pass must not be started
    # (two git merges in one copy, two worktrees for one task), but an HTTP request must not
    # hang waiting for up to 15 minutes either.
    # manual: the owner pressed the button themselves, so the machine load gate does not hold the start.
    dispatcher = _dispatcher(request)
    if not dispatcher.try_tick(manual=True):
        raise HTTPException(409, "the dispatcher is already running a pass, try again later")
    return dispatcher.status()
