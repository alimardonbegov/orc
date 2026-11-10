"""HTTP API. No business logic: input validation, calls to Repo/Dispatcher, serialization.

Routers are split by resource, and a single shared router is exposed outwards, as before:
`from orc.api import router`.
"""
from fastapi import APIRouter

from orc.api import (
    activity, agents, analytics, attachments, board_views, chats, deliverables, git, hooks, labels, projects, routines, settings, task_bulk, task_plans, tasks,
)
from orc.api.common import SETTING_KEYS  # noqa: F401  re-export for those who imported it from orc.api

router = APIRouter(prefix="/api")
# activity goes before agents: /agents/activity must not be taken for /agents/{agent_id}.
# task_plans and task_bulk go before tasks for the same reason: /tasks/context is not /tasks/{task_id}.
for module in (projects, board_views, task_plans, task_bulk, tasks, labels, routines, activity, agents, chats, git, hooks, settings, attachments, deliverables, analytics):
    router.include_router(module.router)
