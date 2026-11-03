import subprocess

import pytest
from fastapi.testclient import TestClient

from orc import trust
from orc.config import Settings
from orc.db import connect, init_schema
from orc.dispatcher import Dispatcher
from orc.machine import MachineLoad
from orc.repo import Repo
from orc.server import create_app
from tests.fakes import FakeClaudeCli


@pytest.fixture
def repo(tmp_path):
    conn = connect(tmp_path / "orc.db")
    init_schema(conn)
    return Repo(conn)


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.fixture
def git_repo(tmp_path):
    """A repository with a main branch and a single commit of the file a.txt."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(["init", "-b", "main"], repo)
    _git(["config", "user.email", "t@t"], repo)
    _git(["config", "user.name", "t"], repo)
    (repo / "a.txt").write_text("1\n")
    _git(["add", "a.txt"], repo)
    _git(["commit", "-m", "init"], repo)
    return repo


@pytest.fixture
def fake_cli():
    return FakeClaudeCli()


@pytest.fixture
def dispatcher(repo, fake_cli, tmp_path):
    # The limit sources are also moved under tmp_path: otherwise a test would read (and the statusline collector
    # would write) the real ~/.claude/usage-cache.json and ~/.claude.json on the developer machine.
    # usage_probe_enabled=False: the limits probe launches the real `claude`, and without this
    # half of the test suite would hit the network and burn the developer limits.
    settings = Settings(data_dir=tmp_path / "data", jobs_dir=tmp_path / "jobs",
                         usage_cache_path=tmp_path / "usage-cache.json",
                         claude_json_path=tmp_path / "claude.json",
                         usage_probe_enabled=False,
                         # TestClient sends Host: testserver and comes from the testclient address,
                         # without them the perimeter (orc/security.py) would reject every test request
                         allowed_hosts=("127.0.0.1", "localhost", "::1", "testserver"),
                         allowed_clients=("127.0.0.1", "::1", "testclient"))
    # Test folders are trusted by Claude Code, as for an owner who has already worked in their projects:
    # without this every start would hit the untrusted blocker (orc/trust.py). Tests of untrusted
    # projects rewrite the file themselves.
    trust.grant(settings.claude_json_path, tmp_path)
    # sleep stub: waiting for the session to stop before a resume must not
    # turn the test suite into a multi-second wait
    # The load sampler is replaced: the start gate must not depend on the developer machine load
    return Dispatcher(repo, settings, fake_cli, sleep=lambda _: None,
                      machine_sampler=lambda: MachineLoad(0.0, 8, 100))


@pytest.fixture
def project(repo, git_repo):
    return repo.add_project("demo", str(git_repo))


@pytest.fixture
def client(repo, dispatcher):
    """HTTP client on top of the same repo and dispatcher: the background loop is off, ticks are triggered by hand.

    The dashboard token is set by default: otherwise the header would have to be added in each of the hundreds of
    existing tests. Rejection tests use anon_client.
    """
    app = create_app(dispatcher.settings, repo, dispatcher, static_dir=None, run_loop=False)
    return TestClient(app, headers={"x-orc-token": repo.get_setting("pult_token")})


@pytest.fixture
def anon_client(repo, dispatcher):
    """The same server without the dashboard token: this is what a request from an agent session or curl looks like."""
    app = create_app(dispatcher.settings, repo, dispatcher, static_dir=None, run_loop=False)
    return TestClient(app)


@pytest.fixture
def settle(dispatcher):
    """Run a tick, wait for the checks in the pool and run again.

    With the verify pool the result does not appear in the same pass in which the task was sent
    to be checked: the test must let the pool finish.
    """
    def _settle(times: int = 2):
        for _ in range(times):
            dispatcher.tick()
            dispatcher.verify_pool.wait(10)
    return _settle
