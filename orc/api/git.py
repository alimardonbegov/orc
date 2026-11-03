"""The /git/branches* and /git/worktrees* endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from orc import branches, git_ops, worktrees
from orc.api.common import _branch_op, _dispatcher, _repo, _working_project

router = APIRouter()


class BranchIn(BaseModel):
    project_id: int
    name: str = Field(min_length=1)
    # What to branch from. None means the project's base branch.
    base: str | None = None


class BranchRenameIn(BaseModel):
    project_id: int
    name: str = Field(min_length=1)
    new_name: str = Field(min_length=1)


class BranchDeleteIn(BaseModel):
    project_id: int
    name: str = Field(min_length=1)
    # Confirmation of warnings (unmerged commits, tasks waiting for this base).
    # Prohibitions (a running task, a busy worktree) are not bypassed by it.
    force: bool = False


@router.get("/git/branches")
def git_branches(project_id: int, request: Request):
    """Project branches with full context: who holds them and what will break on deletion."""
    project = _working_project(request, project_id)
    try:
        return branches.overview(_repo(request), project)
    except git_ops.GitError as e:
        raise HTTPException(400, str(e))


@router.post("/git/branches", status_code=201)
def create_branch(body: BranchIn, request: Request):
    project = _working_project(request, body.project_id)
    return _branch_op(lambda: branches.create(_repo(request), project, body.name, body.base))


@router.post("/git/branches/rename")
def rename_branch(body: BranchRenameIn, request: Request):
    """Renaming is not only in git: all cards that referred to the old name follow it."""
    project = _working_project(request, body.project_id)
    return _branch_op(lambda: branches.rename(_repo(request), project, body.name, body.new_name))


@router.post("/git/branches/delete")
def delete_branch(body: BranchDeleteIn, request: Request):
    project = _working_project(request, body.project_id)
    return _branch_op(lambda: branches.delete(_repo(request), project, body.name, force=body.force))


class WorktreesDeleteIn(BaseModel):
    project_id: int
    # Folder names in the project's .claude/worktrees: one means delete by name, many means "remove all".
    names: list[str] = Field(min_length=1)
    # Confirmation of warnings (uncommitted changes, unmerged branch, processes in the folder, someone
    # else's copy). Prohibitions (a running task, a merge, git worktree lock) are not bypassed by it.
    force: bool = False


@router.get("/git/worktrees")
def git_worktrees(project_id: int, request: Request):
    """Project working copies: whose they are, how much they weigh, whether merged and whether anyone is working in them."""
    project = _working_project(request, project_id)
    try:
        return worktrees.overview(_repo(request), project)
    except git_ops.GitError as e:
        raise HTTPException(400, str(e))


@router.post("/git/worktrees/delete")
def delete_worktrees(body: WorktreesDeleteIn, request: Request):
    """A prohibition is 400, "confirm" is 409, as with branches."""
    project = _working_project(request, body.project_id)
    try:
        view, note = _dispatcher(request).delete_worktrees(project, body.names, force=body.force)
    except worktrees.WorktreeNeedsConfirm as e:
        raise HTTPException(409, str(e))
    except (worktrees.WorktreeError, git_ops.GitError) as e:
        raise HTTPException(400, str(e))
    return {**view, "note": note}
