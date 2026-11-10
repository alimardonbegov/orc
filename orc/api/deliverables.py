"""Files a session hands in as a card's result: `orc task attach` posts them, the card lists and opens them."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from orc.api.common import _attachments, _check_hook_secret, _repo
from orc.attachments import AttachmentError
from orc.deliverables import NEUTRAL_MIME, DeliverableStore, kind_of, serve_headers

router = APIRouter()


class DeliverableIn(BaseModel):
    name: str
    # base64, as for images: multipart would need one more dependency for one endpoint
    data: str


def _store(request: Request) -> DeliverableStore:
    return DeliverableStore(_attachments(request))


@router.post("/hooks/tasks/{task_id}/deliverables", status_code=201)
def hook_add_deliverable(task_id: int, body: DeliverableIn, request: Request):
    _check_hook_secret(request, task_id)
    if _repo(request).get_task(task_id) is None:
        raise HTTPException(404, f"task #{task_id} not found")
    store = _store(request)
    try:
        row = store.add_base64(task_id, body.name, body.data)
    except AttachmentError as e:
        raise HTTPException(400, str(e))
    return {**store._view(row), "duplicate": row["duplicate"]}


@router.get("/tasks/{task_id}/deliverables")
def list_deliverables(task_id: int, request: Request):
    if _repo(request).get_task(task_id) is None:
        raise HTTPException(404, "task not found")
    return _store(request).grouped(task_id)


@router.get("/deliverables/{deliverable_id}/file")
def deliverable_file(deliverable_id: int, request: Request, inline: bool = False):
    row = _repo(request).get_deliverable(deliverable_id)
    if row is None:
        raise HTTPException(404, "file not found")
    path = _attachments(request).root / row["rel_path"]
    if not path.exists():
        raise HTTPException(404, "the file is missing from disk")
    kind = kind_of(row["name"])
    if kind is None:  # a name this version does not know: never guess a type for it
        return FileResponse(path, media_type=NEUTRAL_MIME, filename=row["name"],
                            headers={"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"})
    # FileResponse(filename=...) would set its own Content-Disposition; ours is set below with the encoded name
    response = FileResponse(path, media_type=kind.mime, filename=row["name"],
                            content_disposition_type="inline" if (inline and kind.inline) else "attachment")
    for key, value in serve_headers(kind, inline).items():
        if key != "Content-Disposition":
            response.headers[key] = value
    return response
