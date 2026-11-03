"""The /projects* endpoints and claude-md."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from orc import claude_md, projects, viewing
from orc.api.common import (PROJECT_ARCHIVED_FILTERS, _check_branch_exists, _check_mode, _project_or_404, _project_out,
                            _repo, hidden_models_json)
from orc.util import utc_now

router = APIRouter()


class ProjectIn(BaseModel):
    name: str = Field(min_length=1)
    path: str
    default_model: str | None = None
    default_effort: str | None = None
    default_permission_mode: str = "auto"
    # Base branch for new tasks. None means use the repository's current branch.
    default_branch: str | None = None
    verify_cmd: str | None = None
    verify_timeout_sec: int = 900
    max_workers: int = 2
    push_enabled: bool = False
    # Models hidden from this project's dropdowns. None means no list of its own, same as in the orc settings.
    hidden_models: list[str] | None = None
    # Result viewing (orc/viewing.py): finished tasks wait for the owner's look.
    track_viewed: bool = True
    # Confirmation from the "no repository at this path" dialog: create the missing folder
    # and init git in it. It does not go into the project fields: it is a permission for a single action.
    init_git: bool = False


class ProjectPatch(BaseModel):
    name: str | None = None
    default_model: str | None = None
    default_effort: str | None = None
    default_permission_mode: str | None = None
    default_branch: str | None = None
    verify_cmd: str | None = None
    verify_timeout_sec: int | None = None
    max_workers: int | None = None
    push_enabled: bool | None = None
    # null means drop the project's own list and return to the shared one from the orc settings
    hidden_models: list[str] | None = None
    track_viewed: bool | None = None
    # Manual order in the sidebar (drag, see web/src/components/Sidebar.tsx). The value is entirely
    # up to the client: the server does not interpret it, only stores it (like a task's position).
    position: int | None = None


class ProjectPathIn(BaseModel):
    """New path to the project's repository. A move is a separate operation, not a PATCH field:
    it has its own checks and its own summary (what was re-linked, what was lost)."""
    path: str = Field(min_length=1)


class ProjectPathCheckIn(BaseModel):
    """The path at which a new project is about to be created. Asked before creation."""
    path: str = Field(min_length=1)


class ClaudeMdIn(BaseModel):
    content: str
    # Fingerprint of the content the client edited (null means the file did not exist). The field is required:
    # a write always follows a read, otherwise someone else's edit is silently overwritten.
    prev_sha: str | None
    # Which memory location we edit: the repository root or .claude/. The default is the root,
    # which is how the endpoint behaved before the second location appeared.
    location: str = claude_md.DEFAULT_LOCATION


@router.get("/projects")
def list_projects(request: Request, archived: str = "hide"):
    if archived not in PROJECT_ARCHIVED_FILTERS:
        raise HTTPException(400, f"archived: expected one of {sorted(PROJECT_ARCHIVED_FILTERS)}")
    return [_project_out(p) for p in _repo(request).list_projects(PROJECT_ARCHIVED_FILTERS[archived])]


@router.post("/projects/check-path")
def check_project_path(body: ProjectPathCheckIn, request: Request):
    """What awaits a new project at this path, before creating it.

    A separate endpoint, not a refusal on POST /projects: the dashboard needs to DISTINGUISH "not allowed"
    from "nothing there yet, but it can be created", so that in the second case it offers a choice instead of
    showing a red error that gives no hint what to do next.
    """
    return projects.new_path_status(body.path, _repo(request))


@router.post("/projects", status_code=201)
def add_project(body: ProjectIn, request: Request):
    _check_mode(body.default_permission_mode)
    try:
        # init_git=True comes only after explicit confirmation in the dialog: without it
        # a missing folder or a folder without git is still a refusal.
        path = projects.prepare_new_path(body.path, init_git=body.init_git)
    except projects.ProjectPathError as e:
        raise HTTPException(400, str(e))
    if body.default_branch:
        _check_branch_exists(path, body.default_branch)
    fields = body.model_dump(exclude={"name", "path", "init_git"})
    fields["push_enabled"] = int(fields["push_enabled"])
    fields["track_viewed"] = int(fields["track_viewed"])
    fields["hidden_models"] = hidden_models_json(fields["hidden_models"])
    try:
        return _project_out(_repo(request).add_project(body.name, str(path.resolve()), **fields))
    except Exception as e:  # UNIQUE and the like
        raise HTTPException(400, str(e))


@router.patch("/projects/{project_id}")
def patch_project(project_id: int, body: ProjectPatch, request: Request):
    # exclude_unset, not exclude_none: null in PATCH means "clear the field"
    fields = body.model_dump(exclude_unset=True)
    _check_mode(fields.get("default_permission_mode"))
    if "push_enabled" in fields:
        fields["push_enabled"] = int(fields["push_enabled"])
    if "hidden_models" in fields:
        fields["hidden_models"] = hidden_models_json(fields["hidden_models"])
    project = _repo(request).get_project(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    if fields.get("default_branch"):
        _check_branch_exists(project.path, fields["default_branch"])
    if "track_viewed" in fields:
        if fields["track_viewed"] is None:
            raise HTTPException(400, "track_viewed: true or false expected")
        fields["track_viewed"] = int(fields["track_viewed"])
        if fields["track_viewed"] and not project.track_viewed:
            # While viewing was off, nobody set marks: without this, turning it on
            # would dump the whole "Done" archive as unviewed. Fresh ones stay as they are.
            _repo(request).mark_all_viewed(project_id, before=viewing.grace_cutoff(utc_now()))
    return _project_out(_repo(request).update_project(project_id, **fields))


@router.post("/projects/{project_id}/mark-viewed")
def mark_all_viewed(project_id: int, request: Request):
    """Mark all: all finished tasks of the project become viewed at once."""
    _project_or_404(request, project_id)
    return {"viewed": _repo(request).mark_all_viewed(project_id)}


@router.post("/projects/{project_id}/path")
def move_project(project_id: int, body: ProjectPathIn, request: Request):
    """Moving a project to another folder: the path, task worktrees and their binding move together.

    Returns not only the card but also a move summary: how many working copies were re-linked
    and what was not found at the new location. A silent success is worse than a refusal here: the person must
    see it if the repository at the new path turned out to lack the branches of its tasks.
    """
    repo = _repo(request)
    project = _project_or_404(request, project_id)
    try:
        result = projects.move(repo, project, body.path)
    except projects.ProjectPathError as e:
        raise HTTPException(400, str(e))
    return {"project": _project_out(result["project"]), "relinked": result["relinked"],
            "warnings": result["warnings"]}


@router.post("/projects/{project_id}/archive")
def archive_project(project_id: int, request: Request):
    project = _project_or_404(request, project_id)
    try:
        return _project_out(projects.archive(_repo(request), project))
    except projects.ProjectPathError as e:
        raise HTTPException(400, str(e))


@router.post("/projects/{project_id}/unarchive")
def unarchive_project(project_id: int, request: Request):
    return _project_out(projects.unarchive(_repo(request), _project_or_404(request, project_id)))


@router.get("/projects/{project_id}/claude-md")
def get_claude_md(project_id: int, request: Request):
    """Project memory files: the root CLAUDE.md and .claude/CLAUDE.md.

    Every session of this repository reads them, including task worktrees. We return both locations
    at once, together with a "file does not exist yet" flag: the UI decides what to show,
    an editor or a "Create" button.
    """
    project = _repo(request).get_project(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    try:
        return claude_md.read(Path(project.path))
    except claude_md.ClaudeMdError as e:
        raise HTTPException(400, str(e))


@router.put("/projects/{project_id}/claude-md")
def put_claude_md(project_id: int, body: ClaudeMdIn, request: Request):
    project = _repo(request).get_project(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    try:
        return claude_md.write(Path(project.path), body.content, body.prev_sha, body.location)
    except claude_md.ClaudeMdConflict as e:
        raise HTTPException(409, str(e))
    except claude_md.ClaudeMdError as e:
        raise HTTPException(400, str(e))
