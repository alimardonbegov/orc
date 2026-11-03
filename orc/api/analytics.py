"""The /analytics and /forecast endpoints: task summary and limit forecast for the dashboard."""
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request

from orc import analytics, forecast, usage
from orc.api.common import _repo
from orc.util import utc_now

router = APIRouter()


@router.get("/analytics")
def get_analytics(request: Request, project_id: int | None = None, days: int = 30):
    """Flow, time, money and breakdowns for a period.

    `project_id` not set means a slice across all projects. `days=0` means all time.
    The period is a closed set: we do not allow an arbitrary number of days here, otherwise a cache
    would have to be bolted onto the response, since every number here is computed by a full pass over the tasks.
    """
    if days not in analytics.ALLOWED_DAYS:
        raise HTTPException(400, f"period must be one of {sorted(analytics.ALLOWED_DAYS)} (0 means all time)")
    repo = _repo(request)
    if project_id is not None and repo.get_project(project_id) is None:
        raise HTTPException(404, f"no project #{project_id}")
    return analytics.build(repo, project_id=project_id, days=days)


@router.get("/forecast")
def get_forecast(request: Request):
    """Account limit forecast and per-project spending inside the current windows (orc/forecast.py).

    The limit is shared across the account, so a per-project slice is not needed here: all projects
    come at once, and the dashboard highlights the selected one. A fresh probe is also recorded in the history,
    otherwise between dispatcher ticks the forecast would lag a minute behind the limits tile in the sidebar.
    """
    settings = request.app.state.settings
    status = usage.read(settings.usage_cache_path, settings.claude_json_path)
    if status["stale"]:
        request.app.state.prober.refresh_async()
    repo = _repo(request)
    forecast.record_limits(repo, status, time.time())
    return forecast.build(repo, status, utc_now())
