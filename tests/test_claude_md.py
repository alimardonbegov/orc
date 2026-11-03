"""Project CLAUDE.md: two storage locations, reading, writing, protection against overwriting someone else's edit."""
from pathlib import Path

from orc import claude_md


def _project(client, git_repo) -> int:
    return client.post("/api/projects", json={"name": "demo", "path": str(git_repo)}).json()["id"]


def _file(body: dict, location: str) -> dict:
    return next(f for f in body["files"] if f["location"] == location)


def test_read_lists_both_locations(client, git_repo):
    pid = _project(client, git_repo)
    r = client.get(f"/api/projects/{pid}/claude-md")
    assert r.status_code == 200
    body = r.json()
    # Claude Code reads memory both from the root and from .claude/, so the UI must show both locations
    # even when the files do not exist yet: the path says where the file will appear.
    assert [f["location"] for f in body["files"]] == ["root", "claude-dir"]
    assert _file(body, "root") == {
        "location": "root", "rel": "CLAUDE.md", "path": str(git_repo / "CLAUDE.md"),
        "exists": False, "content": "", "sha": None, "error": None,
    }
    assert _file(body, "claude-dir")["path"] == str(git_repo / ".claude" / "CLAUDE.md")


def test_read_write_and_delete(client, git_repo):
    pid = _project(client, git_repo)
    r = client.put(f"/api/projects/{pid}/claude-md", json={"content": "# Project\r\nrule", "prev_sha": None})
    assert r.status_code == 200
    saved = r.json()
    # The default location is the root: that is how the endpoint behaved before the second location appeared
    assert saved["location"] == "root"
    # Line endings are normalized and there is a trailing newline: this is an ordinary text file
    assert (git_repo / "CLAUDE.md").read_text() == "# Project\nrule\n"
    assert saved["exists"] and saved["content"] == "# Project\nrule\n" and saved["sha"]
    assert _file(client.get(f"/api/projects/{pid}/claude-md").json(), "root") == saved

    # Empty text means "the file is not needed": it is deleted rather than left as an empty stub in the repository
    r = client.put(f"/api/projects/{pid}/claude-md", json={"content": "   \n", "prev_sha": saved["sha"]})
    assert r.status_code == 200 and r.json()["exists"] is False
    assert not (git_repo / "CLAUDE.md").exists()


def test_write_into_claude_dir_creates_it(client, git_repo):
    pid = _project(client, git_repo)
    assert not (git_repo / ".claude").exists()
    r = client.put(f"/api/projects/{pid}/claude-md",
                   json={"content": "memory", "prev_sha": None, "location": "claude-dir"})
    assert r.status_code == 200
    # The .claude directory may not exist: creating the file must not fail on a missing folder
    assert (git_repo / ".claude" / "CLAUDE.md").read_text() == "memory\n"
    assert not (git_repo / "CLAUDE.md").exists()

    body = client.get(f"/api/projects/{pid}/claude-md").json()
    assert _file(body, "claude-dir")["content"] == "memory\n"
    assert _file(body, "root")["exists"] is False

    # The locations are independent: editing one does not touch the other
    client.put(f"/api/projects/{pid}/claude-md", json={"content": "root", "prev_sha": None})
    assert (git_repo / "CLAUDE.md").read_text() == "root\n"
    assert (git_repo / ".claude" / "CLAUDE.md").read_text() == "memory\n"


def test_unknown_location_is_rejected(client, git_repo):
    pid = _project(client, git_repo)
    r = client.put(f"/api/projects/{pid}/claude-md",
                   json={"content": "x", "prev_sha": None, "location": "somewhere"})
    assert r.status_code == 400


def test_stale_write_is_rejected(client, git_repo):
    pid = _project(client, git_repo)
    client.put(f"/api/projects/{pid}/claude-md", json={"content": "first version", "prev_sha": None})
    stale = _file(client.get(f"/api/projects/{pid}/claude-md").json(), "root")["sha"]
    # The file was changed bypassing the UI (agent, editor): a write with the old fingerprint is rejected
    (git_repo / "CLAUDE.md").write_text("agent edit\n")
    r = client.put(f"/api/projects/{pid}/claude-md", json={"content": "my version", "prev_sha": stale})
    assert r.status_code == 409
    assert (git_repo / "CLAUDE.md").read_text() == "agent edit\n"
    # Re-read, then wrote: there is no conflict anymore
    fresh = _file(client.get(f"/api/projects/{pid}/claude-md").json(), "root")
    r = client.put(f"/api/projects/{pid}/claude-md", json={"content": "my version", "prev_sha": fresh["sha"]})
    assert r.status_code == 200 and (git_repo / "CLAUDE.md").read_text() == "my version\n"

    # Creating over an already existing file (prev_sha=null) is also a conflict, not an overwrite
    r = client.put(f"/api/projects/{pid}/claude-md", json={"content": "from scratch", "prev_sha": None})
    assert r.status_code == 409


def test_missing_project_and_broken_file(client, git_repo, tmp_path):
    assert client.get("/api/projects/777/claude-md").status_code == 404
    assert client.put("/api/projects/777/claude-md", json={"content": "x", "prev_sha": None}).status_code == 404

    pid = _project(client, git_repo)
    # CLAUDE.md turned out to be a directory (or anything but a file): the reason travels inside the file view,
    # not as a rejection of the whole section: the second location must stay editable
    (git_repo / "CLAUDE.md").mkdir()
    body = client.get(f"/api/projects/{pid}/claude-md").json()
    assert "not a file" in _file(body, "root")["error"]
    assert _file(body, "claude-dir")["error"] is None
    # Writing to it is still not allowed
    assert client.put(f"/api/projects/{pid}/claude-md", json={"content": "x", "prev_sha": None}).status_code == 400
    (git_repo / "CLAUDE.md").rmdir()

    # Text that is too long is rejected: the agent does not need that much memory
    r = client.put(f"/api/projects/{pid}/claude-md",
                   json={"content": "x" * (claude_md.MAX_BYTES + 1), "prev_sha": None})
    assert r.status_code == 400 and not (git_repo / "CLAUDE.md").exists()


def test_read_reports_gone_repo(tmp_path):
    # The repository was removed from disk: the module says so in words instead of crashing
    try:
        claude_md.read(Path(tmp_path / "no-such-dir"))
    except claude_md.ClaudeMdError as e:
        assert "does not exist on disk" in str(e)
    else:
        raise AssertionError("ClaudeMdError expected")
