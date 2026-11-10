"""The saved board views: GET/POST /projects/{id}/views, PATCH/DELETE /views/{id} (orc/board_views.py)."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from orc import board_views
from orc.api.common import _repo

router = APIRouter()


class ViewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    filters: dict = {}


class ViewPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    filters: dict | None = None


def _taken(name: str) -> HTTPException:
    return HTTPException(409, f"this project already has a view named {name!r}")


def _out(repo, row: dict) -> dict:
    return board_views.view_out(row, {item["id"] for item in repo.list_labels()})


@router.get("/projects/{project_id}/views")
def list_views(project_id: int, request: Request):
    repo = _repo(request)
    if repo.get_project(project_id) is None:
        raise HTTPException(404, "project not found")
    known = {item["id"] for item in repo.list_labels()}
    return [board_views.view_out(row, known) for row in repo.list_board_views(project_id)]


@router.post("/projects/{project_id}/views", status_code=201)
def add_view(project_id: int, body: ViewIn, request: Request):
    repo = _repo(request)
    if repo.get_project(project_id) is None:
        raise HTTPException(404, "project not found")
    try:
        name, filters = board_views.normalize_name(body.name), board_views.normalize_filters(body.filters)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        row = repo.add_board_view(project_id, name, board_views.dump(filters))
    except sqlite3.IntegrityError:
        raise _taken(name)
    return _out(repo, row)


@router.patch("/views/{view_id}")
def patch_view(view_id: int, body: ViewPatch, request: Request):
    repo = _repo(request)
    if repo.get_board_view(view_id) is None:
        raise HTTPException(404, "view not found")
    fields: dict[str, str] = {}
    try:
        if body.name is not None:
            fields["name"] = board_views.normalize_name(body.name)
        if body.filters is not None:
            fields["filters_json"] = board_views.dump(board_views.normalize_filters(body.filters))
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        row = repo.update_board_view(view_id, **fields)
    except sqlite3.IntegrityError:
        raise _taken(fields.get("name", ""))
    return _out(repo, row)


@router.delete("/views/{view_id}")
def delete_view(view_id: int, request: Request):
    repo = _repo(request)
    if repo.get_board_view(view_id) is None:
        raise HTTPException(404, "view not found")
    repo.delete_board_view(view_id)
    return {"deleted": view_id}
