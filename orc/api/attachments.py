"""The /attachments* and /attachments-limits endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from orc.api.common import _attachments
from orc.attachments import MAX_BYTES, MIME_EXT, AttachmentError

router = APIRouter()


class AttachmentIn(BaseModel):
    filename: str = ""
    mime: str
    # base64 without the data: prefix. We deliberately do not use multipart: python-multipart is not
    # among the dependencies, and pulling it in for a single endpoint costs more than 33% overhead on the request body.
    data: str


@router.post("/attachments", status_code=201)
def add_attachment(body: AttachmentIn, request: Request):
    try:
        row = _attachments(request).save_base64(body.filename, body.mime, body.data)
    except AttachmentError as e:
        raise HTTPException(400, str(e))
    return {**row, "url": f"/api/attachments/{row['id']}"}


@router.get("/attachments/{attachment_id}")
def get_attachment(attachment_id: int, request: Request):
    store = _attachments(request)
    row = store.get(attachment_id)
    if row is None:
        raise HTTPException(404, "attachment not found")
    path = store.path(row)
    if not path.exists():
        raise HTTPException(404, "attachment file is missing from disk")
    return FileResponse(path, media_type=row["mime"], filename=row["filename"])


@router.get("/attachments-limits")
def attachment_limits(request: Request):
    """What the UI is allowed to upload: the list here and the check on input are the same place."""
    store = _attachments(request)
    return {"mime": sorted(MIME_EXT), "max_bytes": MAX_BYTES,
            "max_total_bytes": store.max_total_bytes(), "used_bytes": store.repo.attachments_total_size()}
