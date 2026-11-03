"""HTTP API. No business logic: input validation, calls to Repo/Dispatcher, serialization.

Routers are split by resource, and a single shared router is exposed outwards, as before:
`from orc.api import router`.
"""
from fastapi import APIRouter

from orc.api import analytics, attachments, git, hooks, projects, routines, settings, tasks
from orc.api.common import SETTING_KEYS  # noqa: F401  re-export for those who imported it from orc.api

router = APIRouter(prefix="/api")
for module in (projects, tasks, routines, git, hooks, settings, attachments, analytics):
    router.include_router(module.router)
