"""Files an agent hands in as the result of a card: a report, a screenshot, a built archive.

The bytes go to the attachment store (orc/attachments.py) in the data directory, so they outlive the card's
working copy, which auto-cleanup deletes. A deliverable is a row that ties a stored file to a card under a
display name and a version: handing in a file with the same name again makes the next version, and the old
ones stay.

Nothing here is trusted. The owner opens these files from the dashboard, on the origin of the orchestrator,
so a file must never run there: the type comes from an allowlist of extensions, only images and plain text are
ever shown in the page, and a type that could run script (HTML, SVG, XML) is accepted but served as a download
with a neutral type. See `serve_headers`.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

from orc.attachments import AttachmentError, AttachmentStore

MAX_FILE_BYTES = 20 * 1024 * 1024
# A card that keeps handing in files must not fill the data directory on its own.
MAX_ROWS_PER_CARD = 100
MAX_NAME_LENGTH = 200
NEUTRAL_MIME = "application/octet-stream"


@dataclass(frozen=True)
class FileKind:
    mime: str          # what the file is served as
    inline: bool       # may the page show it (image, plain text); everything else is a download
    active: bool = False  # could run script if a browser rendered it: stored as a neutral download


_IMAGES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
_TEXT = ("txt", "log", "md", "csv", "tsv", "json", "yaml", "yml", "diff", "patch", "toml")
KINDS: dict[str, FileKind] = {
    **{ext: FileKind(mime, inline=True) for ext, mime in _IMAGES.items()},
    **{ext: FileKind("text/plain; charset=utf-8", inline=True) for ext in _TEXT},
    "pdf": FileKind("application/pdf", inline=False),
    "zip": FileKind("application/zip", inline=False),
    "tar": FileKind("application/x-tar", inline=False),
    "gz": FileKind("application/gzip", inline=False),
    "tgz": FileKind("application/gzip", inline=False),
    # Accepted because an HTML report is a normal thing to hand in, but never rendered on our origin
    **{ext: FileKind(NEUTRAL_MIME, inline=False, active=True) for ext in ("html", "htm", "svg", "xml")},
}

_SIGNATURES = {
    "png": (b"\x89PNG\r\n\x1a\n",), "jpg": (b"\xff\xd8\xff",), "jpeg": (b"\xff\xd8\xff",),
    "gif": (b"GIF87a", b"GIF89a"), "webp": (b"RIFF",),
}


def clean_name(raw: str) -> str:
    """The display name: a file name, not a path, without control characters."""
    name = PurePosixPath(raw.replace("\\", "/")).name
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip().lstrip(".")
    return name[:MAX_NAME_LENGTH]


def extension(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def kind_of(name: str) -> FileKind | None:
    return KINDS.get(extension(name))


def allowed_types_text() -> str:
    return ", ".join(sorted(f".{e}" for e in KINDS))


def serve_headers(kind: FileKind, want_inline: bool) -> dict[str, str]:
    """Headers for sending a file to the browser. Defence in depth: the type is already neutral for risky files,
    and these headers stop a browser from guessing a different one or running anything even if it did."""
    inline = want_inline and kind.inline
    return {
        "Content-Disposition": "inline" if inline else "attachment",
        "X-Content-Type-Options": "nosniff",
        # `sandbox` without allow-scripts: no script, no same-origin access, even for a document that slipped through
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "private, max-age=0, must-revalidate",
    }


class DeliverableStore:
    def __init__(self, attachments: AttachmentStore):
        self.attachments = attachments
        self.repo = attachments.repo

    def add(self, task_id: int, filename: str, data: bytes) -> dict:
        name = clean_name(filename)
        if not name:
            raise AttachmentError("the file needs a name")
        kind = kind_of(name)
        if kind is None:
            raise AttachmentError(f"files of type .{extension(name) or '(none)'} cannot be handed in, "
                                  f"expected one of: {allowed_types_text()}")
        if not data:
            raise AttachmentError("empty file")
        if len(data) > MAX_FILE_BYTES:
            raise AttachmentError(f"file is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB")
        signatures = _SIGNATURES.get(extension(name))
        if signatures and not data.startswith(signatures):
            raise AttachmentError(f"the content of {name} is not a {extension(name)} image")
        digest = hashlib.sha256(data).hexdigest()
        latest = self.repo.latest_deliverable(task_id, name)
        if latest and latest["sha256"] == digest:
            return {**latest, "duplicate": True}  # handing in the same file again is not a new version
        if self.repo.count_deliverables(task_id) >= MAX_ROWS_PER_CARD:
            raise AttachmentError(f"a card can hold {MAX_ROWS_PER_CARD} versions of files: remove some or hand in less")
        stored = self.attachments.save_file(name, kind.mime, data)
        row = self.repo.add_deliverable(task_id, name, stored["id"], digest)
        return {**row, "duplicate": False}

    def add_base64(self, task_id: int, filename: str, data: str) -> dict:
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as e:
            raise AttachmentError(f"data cannot be parsed as base64 ({e})")
        return self.add(task_id, filename, raw)

    def grouped(self, task_id: int) -> list[dict]:
        """One entry per name, newest first, each with all its versions (newest first)."""
        groups: dict[str, list[dict]] = {}
        for row in self.repo.list_deliverables(task_id):
            groups.setdefault(row["name"], []).append(self._view(row))
        out = [{"name": name, "latest": versions[0], "versions": versions} for name, versions in groups.items()]
        out.sort(key=lambda g: g["latest"]["created_at"], reverse=True)
        return out

    @staticmethod
    def _view(row: dict) -> dict:
        kind = kind_of(row["name"])
        return {"id": row["id"], "name": row["name"], "version": row["version"], "size": row["size"],
                "created_at": row["created_at"], "mime": kind.mime if kind else NEUTRAL_MIME,
                "inline": bool(kind and kind.inline), "url": f"/api/deliverables/{row['id']}/file"}
