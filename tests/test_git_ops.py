import pytest

from orc import git_ops
from orc.git_ops import GitError


def test_current_branch_and_list(git_repo):
    assert git_ops.current_branch(git_repo) == "main"
    assert git_ops.list_branches(git_repo) == ["main"]


def test_add_worktree_creates_branch_from_base(git_repo):
    wt = git_repo / ".claude" / "worktrees" / "orc-task-1"
    git_ops.add_worktree(git_repo, wt, "orc/task-1", "main")
    assert (wt / "a.txt").exists()
    assert git_ops.current_branch(wt) == "orc/task-1"
    assert git_ops.worktree_for_branch(git_repo, "orc/task-1") == wt.resolve()
    assert git_ops.worktree_for_branch(git_repo, "main") == git_repo.resolve()
    assert git_ops.worktree_for_branch(git_repo, "nope") is None


def test_remove_worktree_and_branch(git_repo):
    wt = git_repo / "wt"
    git_ops.add_worktree(git_repo, wt, "orc/task-2", "main")
    git_ops.remove_worktree(git_repo, wt)
    git_ops.delete_branch(git_repo, "orc/task-2")
    assert not wt.exists()
    assert "orc/task-2" not in git_ops.list_branches(git_repo)


def test_dirty_and_autocommit(git_repo):
    assert git_ops.is_dirty_tracked(git_repo) is False
    (git_repo / "a.txt").write_text("2\n")
    (git_repo / "new.txt").write_text("x")  # untracked files do not count
    assert git_ops.is_dirty_tracked(git_repo) is True
    assert git_ops.autocommit_tracked(git_repo, "wip(orc): test") is True
    assert git_ops.is_dirty_tracked(git_repo) is False
    assert (git_repo / "new.txt").exists()
    assert git_ops.git(["status", "--porcelain"], git_repo) == "?? new.txt"
    assert git_ops.autocommit_tracked(git_repo, "wip(orc): nothing") is False


def test_conflict_detection_and_merge(git_repo):
    wt = git_repo / "wt"
    git_ops.add_worktree(git_repo, wt, "orc/task-3", "main")
    (wt / "b.txt").write_text("b\n")
    git_ops.git(["add", "b.txt"], wt)
    git_ops.git(["commit", "-m", "task"], wt)
    assert git_ops.has_conflict(git_repo, "main", "orc/task-3") is False
    git_ops.merge_no_ff(git_repo, "orc/task-3", "orc: merge task #3")
    assert (git_repo / "b.txt").exists()
    assert git_ops.git(["log", "-1", "--format=%s"], git_repo) == "orc: merge task #3"


def test_conflict_detected(git_repo):
    wt = git_repo / "wt"
    git_ops.add_worktree(git_repo, wt, "orc/task-4", "main")
    (wt / "a.txt").write_text("from task\n")
    git_ops.git(["commit", "-am", "task"], wt)
    (git_repo / "a.txt").write_text("from main\n")
    git_ops.git(["commit", "-am", "main"], git_repo)
    assert git_ops.has_conflict(git_repo, "main", "orc/task-4") is True


def test_temp_worktree_merge_when_branch_not_checked_out(git_repo):
    git_ops.git(["branch", "dev"], git_repo)
    wt = git_repo / "wt"
    git_ops.add_worktree(git_repo, wt, "orc/task-5", "dev")
    (wt / "c.txt").write_text("c\n")
    git_ops.git(["add", "c.txt"], wt)
    git_ops.git(["commit", "-m", "task"], wt)
    tmp = git_repo / ".claude" / "worktrees" / "orc-merge-5"
    git_ops.add_temp_worktree(git_repo, tmp, "dev")
    git_ops.merge_no_ff(tmp, "orc/task-5", "orc: merge task #5")
    git_ops.remove_worktree(git_repo, tmp)
    assert git_ops.git(["ls-tree", "--name-only", "dev"], git_repo).splitlines() == ["a.txt", "c.txt"]


def test_ensure_exclude_idempotent(git_repo):
    git_ops.ensure_exclude(git_repo, ".orchestrator/")
    git_ops.ensure_exclude(git_repo, ".orchestrator/")
    text = (git_repo / ".git" / "info" / "exclude").read_text()
    assert text.count(".orchestrator/") == 1


def test_git_error(git_repo):
    with pytest.raises(GitError):
        git_ops.git(["checkout", "no-such-branch"], git_repo)


# ---------- merge in progress and conflicts ----------


def _conflicting_merge(git_repo):
    """Leaves the working copy in an unfinished merge with a conflict in a.txt."""
    git_ops.git(["checkout", "-b", "side"], git_repo)
    (git_repo / "a.txt").write_text("side\n")
    git_ops.git(["commit", "-am", "side"], git_repo)
    git_ops.git(["checkout", "main"], git_repo)
    (git_repo / "a.txt").write_text("main\n")
    git_ops.git(["commit", "-am", "main"], git_repo)
    with pytest.raises(GitError):
        git_ops.merge_no_ff(git_repo, "side", "conflict")


def test_is_merge_in_progress_and_merge_abort(git_repo):
    assert git_ops.is_merge_in_progress(git_repo) is False
    _conflicting_merge(git_repo)
    assert git_ops.is_merge_in_progress(git_repo) is True
    assert "<<<<<<<" in (git_repo / "a.txt").read_text()
    git_ops.merge_abort(git_repo)
    assert git_ops.is_merge_in_progress(git_repo) is False
    assert (git_repo / "a.txt").read_text() == "main\n"  # the owner's edits are still in place
    assert git_ops.git(["status", "--porcelain"], git_repo) == ""


def test_is_merge_in_progress_is_per_worktree(git_repo):
    # A linked worktree has its own git directory: an unfinished merge in it must not look
    # like an unfinished merge in the main copy, and vice versa.
    git_ops.git(["branch", "dev"], git_repo)
    wt = git_repo / "wt"
    git_ops.add_temp_worktree(git_repo, wt, "dev")
    _conflicting_merge(git_repo)
    assert git_ops.is_merge_in_progress(git_repo) is True
    assert git_ops.is_merge_in_progress(wt) is False


def test_conflict_files_names_only_the_conflicting_ones(git_repo):
    (git_repo / "b.txt").write_text("shared\n")
    git_ops.git(["add", "b.txt"], git_repo)
    git_ops.git(["commit", "-m", "b"], git_repo)
    git_ops.git(["checkout", "-b", "side"], git_repo)
    (git_repo / "a.txt").write_text("side\n")
    (git_repo / "c.txt").write_text("only here\n")
    git_ops.git(["add", "."], git_repo)
    git_ops.git(["commit", "-am", "side"], git_repo)
    git_ops.git(["checkout", "main"], git_repo)
    (git_repo / "a.txt").write_text("main\n")
    git_ops.git(["commit", "-am", "main"], git_repo)
    # both branches edited one line of a.txt, only side touched c.txt: only a.txt conflicts
    assert git_ops.conflict_files(git_repo, "main", "side") == ["a.txt"]
    # the working copy is untouched
    assert git_ops.git(["status", "--porcelain"], git_repo) == ""


def test_conflict_files_empty_when_merge_is_clean(git_repo):
    git_ops.git(["checkout", "-b", "side"], git_repo)
    (git_repo / "c.txt").write_text("only here\n")
    git_ops.git(["add", "c.txt"], git_repo)
    git_ops.git(["commit", "-m", "side"], git_repo)
    git_ops.git(["checkout", "main"], git_repo)
    assert git_ops.conflict_files(git_repo, "main", "side") == []


def test_incoming_commits_lists_what_target_gained(git_repo):
    git_ops.git(["branch", "side"], git_repo)
    (git_repo / "a.txt").write_text("main\n")
    git_ops.git(["commit", "-am", "another task"], git_repo)
    incoming = git_ops.incoming_commits(git_repo, "main", "side")
    assert len(incoming) == 1 and incoming[0].endswith("another task")
    assert git_ops.incoming_commits(git_repo, "side", "main") == []


# ---------- branch management from the UI ----------


def test_create_rename_and_soft_delete_branch(git_repo):
    git_ops.create_branch(git_repo, "dev", "main")
    assert "dev" in git_ops.list_branches(git_repo)
    git_ops.rename_branch(git_repo, "dev", "develop")
    assert git_ops.list_branches(git_repo) == ["develop", "main"]
    with pytest.raises(GitError):  # -m does not overwrite an existing branch
        git_ops.rename_branch(git_repo, "develop", "main")
    git_ops.delete_branch(git_repo, "develop", force=False)
    assert git_ops.list_branches(git_repo) == ["main"]


def test_is_valid_branch_name(git_repo):
    assert git_ops.is_valid_branch_name(git_repo, "feature/x") is True
    for bad in ("", "-f", "with space", "bad..branch", "tail.lock", "branch~1"):
        assert git_ops.is_valid_branch_name(git_repo, bad) is False, bad


def test_is_merged_and_detailed_listing(git_repo):
    wt = git_repo / "wt"
    git_ops.add_worktree(git_repo, wt, "dev", "main")
    assert git_ops.is_merged(git_repo, "dev", "main") is True
    (wt / "b.txt").write_text("b\n")
    git_ops.git(["add", "b.txt"], wt)
    git_ops.git(["commit", "-m", "own work"], wt)
    assert git_ops.is_merged(git_repo, "dev", "main") is False
    rows = {r["name"]: r for r in git_ops.list_branches_detailed(git_repo)}
    assert rows["dev"]["subject"] == "own work" and rows["dev"]["commit"]
    assert git_ops.worktrees_by_branch(git_repo) == {"main": git_repo.resolve(), "dev": wt.resolve()}


# ---------- git timeouts and environment ----------


def test_git_timeout_becomes_git_error(tmp_path, monkeypatch):
    """A hung git (waiting for a password, stuck on the network) must not hang the dispatcher thread."""
    import subprocess

    def slow_run(args, cwd, **kwargs):
        raise subprocess.TimeoutExpired(args, kwargs.get("timeout", 0))

    monkeypatch.setattr(git_ops.subprocess, "run", slow_run)
    with pytest.raises(GitError) as e:
        git_ops.git(["status"], tmp_path)
    assert "timed out" in str(e.value)


def test_push_uses_network_timeout(tmp_path, monkeypatch):
    seen = {}

    def capture(args, cwd, **kwargs):
        seen["timeout"] = kwargs.get("timeout")

        class R:
            returncode = 0
            stdout = ""
            stderr = ""

        return R()

    monkeypatch.setattr(git_ops.subprocess, "run", capture)
    git_ops.push(tmp_path, "main")
    assert seen["timeout"] == git_ops.GIT_NETWORK_TIMEOUT_SEC
    git_ops.git(["status"], tmp_path)
    assert seen["timeout"] == git_ops.GIT_TIMEOUT_SEC


def test_git_env_forbids_interactive_prompt(tmp_path, monkeypatch):
    """Without this, `git push` over HTTPS waits for a login, and over ssh waits for a key
    passphrase, and hangs forever."""
    seen = {}

    def capture(args, cwd, **kwargs):
        seen.update(kwargs.get("env") or {})

        class R:
            returncode = 0
            stdout = ""
            stderr = ""

        return R()

    monkeypatch.setattr(git_ops.subprocess, "run", capture)
    monkeypatch.delenv("GIT_SSH_COMMAND", raising=False)
    git_ops.git(["status"], tmp_path)
    assert seen["GIT_TERMINAL_PROMPT"] == "0"
    assert seen["GIT_ASKPASS"] == "/usr/bin/true"
    assert seen["SSH_ASKPASS"] == "/usr/bin/true"
    assert seen["GIT_SSH_COMMAND"] == "ssh -o BatchMode=yes"
    # The environment is not replaced entirely: PATH must get through, otherwise git will not be found
    assert "PATH" in seen


def test_git_env_keeps_user_ssh_command(tmp_path, monkeypatch):
    """The owner sets their own ssh command (own key, own config) themselves; we do not overwrite it."""
    seen = {}

    def capture(args, cwd, **kwargs):
        seen.update(kwargs.get("env") or {})

        class R:
            returncode = 0
            stdout = ""
            stderr = ""

        return R()

    monkeypatch.setattr(git_ops.subprocess, "run", capture)
    monkeypatch.setenv("GIT_SSH_COMMAND", "ssh -i ~/.ssh/work")
    git_ops.git(["status"], tmp_path)
    assert seen["GIT_SSH_COMMAND"] == "ssh -i ~/.ssh/work"
