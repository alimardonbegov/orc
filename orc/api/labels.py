"""The /labels endpoints: the global list of labels a card can carry (orc/labels.py)."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from orc import labels
from orc.api.common import _repo

router = APIRouter()


class LabelIn(BaseModel):
    name: str
    color: str | None = None


class LabelPatch(BaseModel):
    name: str | None = None
    color: str | None = None


def _taken(name: str) -> HTTPException:
    return HTTPException(409, f"a label named {name!r} already exists")


@router.get("/labels")
def list_labels(request: Request):
    return _repo(request).list_labels()


@router.post("/labels", status_code=201)
def add_label(body: LabelIn, request: Request):
    repo = _repo(request)
    try:
        name, color = labels.normalize_name(body.name), labels.normalize_color(body.color)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        return {**repo.add_label(name, color), "task_count": 0}
    except sqlite3.IntegrityError:
        raise _taken(name)


@router.patch("/labels/{label_id}")
def patch_label(label_id: int, body: LabelPatch, request: Request):
    repo = _repo(request)
    if repo.get_label(label_id) is None:
        raise HTTPException(404, "label not found")
    fields: dict[str, str] = {}
    try:
        if body.name is not None:
            fields["name"] = labels.normalize_name(body.name)
        if body.color is not None:
            fields["color"] = labels.normalize_color(body.color)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        repo.update_label(label_id, **fields)
    except sqlite3.IntegrityError:
        raise _taken(fields.get("name", ""))
    return next(item for item in repo.list_labels() if item["id"] == label_id)


@router.delete("/labels/{label_id}")
def delete_label(label_id: int, request: Request):
    repo = _repo(request)
    if repo.get_label(label_id) is None:
        raise HTTPException(404, "label not found")
    repo.delete_label(label_id)
    return {"deleted": label_id}
