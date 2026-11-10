"""Images in the task text: file storage and expanding markers into the prompt.

The orchestrator starts a session with a single text argument (`claude --bg ... "<prompt>"`),
so there is no way to attach a binary to the launch. But Claude Code reads images from disk with the
Read tool, so the image reaches the session like this: the file lives in the data directory, and in the prompt
its place holds an absolute path. The position in the text is preserved because the marker is a substring
of the description itself, not a separate list of attachments.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import re
from pathlib import Path
from typing import Callable

from orc.repo import Repo

# ![caption](orc-image:7). The caption has no line breaks and no ']' so that the marker cannot be
# "cut open" halfway through the text by a stray bracket.
MARKER_RE = re.compile(r"!\[([^\]\n]*)\]\(orc-image:(\d+)\)")

# Formats that Read shows to the model as an image. Everything else is rejected on input:
# a silently accepted pdf would look like an attachment, but in the prompt it would turn into a path
# for which Read returns not an image.
MIME_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}
MAX_BYTES = 10 * 1024 * 1024
# Ceiling on all attachments together, in megabytes. Attachments are not tied to a task and are
# never deleted, so without a total ceiling the directory grows without bound.
DEFAULT_MAX_TOTAL_MB = 500

# The hint is appended to the end of the description, and only if it contained images: an empty
# "Images" heading in every prompt is noise that the model learns to skip.
IMAGES_HINT = """

# Images
The text above contains markers like `[Image N: /path — «name»]`. These are real files on disk:
open each one with the Read tool at the given path and it will show the picture. The marker's position matters:
the image belongs to the piece of text next to which it stands."""


class AttachmentError(ValueError):
    """Input rejected: wrong image type, broken base64, file too large."""


def marker(attachment_id: int, caption: str = "") -> str:
    """Marker to insert into the text. Characters that break parsing are removed from the caption."""
    safe = re.sub(r"[\]\[\)\(\n]", " ", caption).strip()
    return f"![{safe}](orc-image:{attachment_id})"


def marker_ids(text: str) -> list[int]:
    """Image ids in the order they appear in the text."""
    return [int(m.group(2)) for m in MARKER_RE.finditer(text or "")]


class AttachmentStore:
    """Attachment files on disk plus their metadata in the DB.

    The directory is shared by the whole orchestrator, not per project: an image belongs to the task
    statement, not to the repository, and must survive worktree cleanup.
    """

    def __init__(self, repo: Repo, root: Path):
        self.repo = repo
        self.root = Path(root)

    def save(self, filename: str, mime: str, data: bytes) -> dict:
        if mime not in MIME_EXT:
            raise AttachmentError(f"format {mime!r} is not supported, expected one of {sorted(MIME_EXT)}")
        if not data:
            raise AttachmentError("empty file")
        if len(data) > MAX_BYTES:
            raise AttachmentError(f"file is larger than {MAX_BYTES // (1024 * 1024)} MB")
        limit = self.max_total_bytes()
        used = self.repo.attachments_total_size()
        if used + len(data) > limit:
            raise AttachmentError(
                f"attachments use {used // (1024 * 1024)} MB of {limit // (1024 * 1024)} MB "
                f"(setting attachments_max_total_mb): no room for a {len(data) // 1024} KB file"
            )
        # The name on disk comes from the content: the same screenshot pasted twice
        # does not take up space twice, while the DB record is still separate for each paste
        # (they may have different captions).
        rel = hashlib.sha256(data).hexdigest()[:32] + MIME_EXT[mime]
        self.root.mkdir(parents=True, exist_ok=True)
        path = self.root / rel
        if not path.exists():
            path.write_bytes(data)
        return self.repo.add_attachment(filename=filename or rel, mime=mime, size=len(data), rel_path=rel)

    def save_file(self, filename: str, mime: str, data: bytes) -> dict:
        """A file of any already-vetted type (see orc/deliverables.py), under the same total ceiling.
        Stored with a neutral extension: nothing in the data directory is named like something that can run."""
        limit = self.max_total_bytes()
        used = self.repo.attachments_total_size()
        if used + len(data) > limit:
            raise AttachmentError(
                f"attachments use {used // (1024 * 1024)} MB of {limit // (1024 * 1024)} MB "
                f"(setting attachments_max_total_mb): no room for a {len(data) // 1024} KB file"
            )
        rel = hashlib.sha256(data).hexdigest()[:32] + ".bin"
        self.root.mkdir(parents=True, exist_ok=True)
        path = self.root / rel
        if not path.exists():
            path.write_bytes(data)
        return self.repo.add_attachment(filename=filename, mime=mime, size=len(data), rel_path=rel)

    def save_base64(self, filename: str, mime: str, data: str) -> dict:
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as e:
            raise AttachmentError(f"data cannot be parsed as base64 ({e})")
        return self.save(filename, mime, raw)

    def max_total_bytes(self) -> int:
        """Ceiling from the settings. Garbage in the value is no reason to refuse attachments: we take the default."""
        raw = self.repo.get_setting("attachments_max_total_mb", str(DEFAULT_MAX_TOTAL_MB))
        try:
            return max(1, int(raw)) * 1024 * 1024
        except (TypeError, ValueError):
            return DEFAULT_MAX_TOTAL_MB * 1024 * 1024

    def get(self, attachment_id: int) -> dict | None:
        return self.repo.get_attachment(attachment_id)

    def path(self, row: dict) -> Path:
        return self.root / row["rel_path"]

    def resolve(self, attachment_id: int) -> tuple[str, str] | None:
        """(absolute path, file name), or None if the record or the file is gone."""
        row = self.get(attachment_id)
        if row is None:
            return None
        path = self.path(row)
        if not path.exists():
            return None
        return str(path.resolve()), row["filename"]


def expand_description(text: str, resolve: Callable[[int], tuple[str, str] | None]) -> str:
    """Image markers -> lines with absolute paths plus a hint block at the end.

    resolve returns (path, name) by attachment id. A missing attachment does not break the launch: an
    honest note stays in its place, and the session at least knows that an image was there.
    """
    if not text or not MARKER_RE.search(text):
        return text or ""
    counter = 0

    def replace(m: re.Match[str]) -> str:
        nonlocal counter
        counter += 1
        caption = m.group(1).strip()
        found = resolve(int(m.group(2)))
        if found is None:
            return f"[Image {counter}: file not found]"
        path, filename = found
        title = caption or filename
        return f"[Image {counter}: {path} — «{title}»]"

    return MARKER_RE.sub(replace, text) + IMAGES_HINT
