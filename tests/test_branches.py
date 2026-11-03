"""Project branches: summary, creation, renaming, deletion and their restrictions."""
import pytest

from orc import branches, git_ops
from orc.branches import BranchError, BranchNeedsConfirm


def _named(view, name):
    return next(i for i in view["items"] if i["name"] == name)


def test_overview_marks_current_base_and_tasks(repo, project, git_repo):
    git_ops.create_branch(git_repo, "dev", "main")
    t = repo.add_task(project.id, "A", target_branch="dev", status="todo")
    view = branches.overview(repo, project)
    assert view["current"] == "main" and view["base"] == "main" and view["default_branch"] is None
    assert view["branches"] == ["dev", "main"]
    dev = _named(view, "dev")
    assert dev["target_of"] == [t.id] and dev["branch_of"] == [] and dev["busy"] is False
    assert _named(view, "main")["is_current"] is True and _named(view, "main")["is_base"] is True


def test_base_follows_project_default_branch(repo, project, git_repo):
    git_ops.create_branch(git_repo, "dev", "main")
    project = repo.update_project(project.id, default_branch="dev")
    view = branches.overview(repo, project)
    assert view["base"] == "dev" and _named(view, "dev")["is_base"] is True


def test_create_validates_name_and_base(repo, project, git_repo):
    view, note = branches.create(repo, project, "feature/x", None)
    assert "feature/x" in view["branches"] and "from main" in note
    with pytest.raises(BranchError, match="already exists"):
        branches.create(repo, project, "feature/x", None)
    with pytest.raises(BranchError, match="does not accept the name"):
        branches.create(repo, project, "with a space", None)
    with pytest.raises(BranchError, match="is empty"):
        branches.create(repo, project, "   ", None)
    with pytest.raises(BranchError, match="to create from"):
        branches.create(repo, project, "another", "no-such-branch")


def test_rename_moves_task_references(repo, project, git_repo):
    git_ops.create_branch(git_repo, "dev", "main")
    a = repo.add_task(project.id, "A", target_branch="dev", status="todo")
    b = repo.add_task(project.id, "B", target_branch="dev", status="done")
    repo.update_task(b.id, branch="dev")
    repo.update_project(project.id, default_branch="dev")
    view, note = branches.rename(repo, repo.get_project(project.id), "dev", "develop")
    assert "develop" in view["branches"] and "dev" not in view["branches"]
    assert repo.get_task(a.id).target_branch == "develop"
    assert repo.get_task(b.id).branch == "develop"
    assert repo.get_project(project.id).default_branch == "develop"
    assert "base branch" in note


def test_rename_refuses_busy_branch(repo, project, git_repo):
    git_ops.create_branch(git_repo, "dev", "main")
    repo.add_task(project.id, "A", target_branch="dev", status="merging")
    with pytest.raises(BranchError, match="is being merged"):
        branches.rename(repo, project, "dev", "develop")


def test_rename_refuses_existing_and_same_name(repo, project, git_repo):
    git_ops.create_branch(git_repo, "dev", "main")
    with pytest.raises(BranchError, match="matches"):
        branches.rename(repo, project, "dev", "dev")
    with pytest.raises(BranchError, match="already exists"):
        branches.rename(repo, project, "dev", "main")
    with pytest.raises(BranchError, match="does not exist in the repository"):
        branches.rename(repo, project, "no-such-branch", "dev")


def test_delete_refuses_current_branch(repo, project, git_repo):
    with pytest.raises(BranchError, match="current branch"):
        branches.delete(repo, project, "main", force=True)


def test_delete_refuses_branch_of_running_task(repo, project, git_repo):
    wt = git_repo / ".claude" / "worktrees" / "orc-task-1"
    git_ops.add_worktree(git_repo, wt, "orc/task-1", "main")
    task = repo.add_task(project.id, "A", status="in_progress")
    repo.update_task(task.id, branch="orc/task-1", worktree_path=str(wt))
    with pytest.raises(BranchError, match="task is working"):
        branches.delete(repo, project, "orc/task-1", force=True)
    assert _named(branches.overview(repo, project), "orc/task-1")["busy"] is True


def test_delete_refuses_target_of_merging_task(repo, project, git_repo):
    git_ops.create_branch(git_repo, "dev", "main")
    repo.add_task(project.id, "A", target_branch="dev", status="merging")
    with pytest.raises(BranchError, match="is being merged"):
        branches.delete(repo, project, "dev", force=True)


def test_delete_refuses_branch_busy_in_worktree(repo, project, git_repo):
    # No task holds the branch, but it is checked out in the working copy: git will not give it up
    git_ops.create_branch(git_repo, "dev", "main")
    git_ops.add_temp_worktree(git_repo, git_repo / "wt", "dev")
    with pytest.raises(BranchError, match="working copy"):
        branches.delete(repo, project, "dev", force=True)


def test_delete_refuses_branch_of_archived_task(repo, project, git_repo):
    # The archived card is gone from the board, but its branch exists on disk: it cannot be removed silently
    git_ops.create_branch(git_repo, "orc/task-9", "main")
    task = repo.add_task(project.id, "A", status="done")
    repo.update_task(task.id, branch="orc/task-9")
    with pytest.raises(BranchError, match="working branch of task"):
        branches.delete(repo, project, "orc/task-9", force=True)


def test_delete_warns_about_unmerged_commits(repo, project, git_repo):
    wt = git_repo / "wt"
    git_ops.add_worktree(git_repo, wt, "dev", "main")
    (wt / "b.txt").write_text("b\n")
    git_ops.git(["add", "b.txt"], wt)
    git_ops.git(["commit", "-m", "work"], wt)
    git_ops.remove_worktree(git_repo, wt)
    assert _named(branches.overview(repo, project), "dev")["merged"] is False
    with pytest.raises(BranchNeedsConfirm, match="will be lost"):
        branches.delete(repo, project, "dev")
    view, note = branches.delete(repo, project, "dev", force=True)
    assert "dev" not in view["branches"] and "deleted" in note


def test_delete_repoints_waiting_tasks_to_base(repo, project, git_repo):
    git_ops.create_branch(git_repo, "dev", "main")
    a = repo.add_task(project.id, "A", target_branch="dev", status="todo")
    with pytest.raises(BranchNeedsConfirm, match="use it as their base"):
        branches.delete(repo, project, "dev")
    view, note = branches.delete(repo, project, "dev", force=True)
    assert "dev" not in view["branches"]
    assert repo.get_task(a.id).target_branch == "main"
    assert f"#{a.id}" in note


def test_delete_resets_project_default_branch(repo, project, git_repo):
    git_ops.create_branch(git_repo, "dev", "main")
    project = repo.update_project(project.id, default_branch="dev")
    _, note = branches.delete(repo, project, "dev", force=True)
    assert repo.get_project(project.id).default_branch is None
    assert "base branch was reset" in note


def test_delete_unknown_branch(repo, project, git_repo):
    with pytest.raises(BranchError, match="does not exist in the repository"):
        branches.delete(repo, project, "no-such-branch", force=True)
