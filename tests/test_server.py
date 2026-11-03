"""App assembly tests: the background thread loop and static file serving."""
import threading

import pytest
from fastapi.testclient import TestClient

from orc.server import _run_loop, create_app


class _StopAfterFirstTick:
    """Stub dispatcher: one tick and ask the loop to stop."""

    def __init__(self, settings, stop):
        self.settings = settings
        self.stop = stop
        self.ticks = 0

    def tick(self):
        self.ticks += 1
        self.stop.set()


def test_run_loop_survives_garbage_poll_interval(repo, dispatcher):
    # Garbage in poll_interval_sec must not kill the dispatcher thread. Before the fix int(...)
    # was raised OUTSIDE try and the orc-dispatcher thread died for good, while GET /api/dispatcher kept
    # returning paused: false, so the owner saw "all fine" while the board stood still.
    repo.set_setting("poll_interval_sec", "fast")
    stop = threading.Event()
    fake = _StopAfterFirstTick(dispatcher.settings, stop)
    _run_loop(fake, repo, stop)  # must not raise
    assert fake.ticks == 1


def test_run_loop_survives_broken_repo(repo, dispatcher):
    # Settings are read from the DB: a read failure (locked database, corrupted file) must not
    # take the thread down either: the interval is then taken from Settings.
    stop = threading.Event()
    fake = _StopAfterFirstTick(dispatcher.settings, stop)

    class BrokenRepo:
        def get_setting(self, *a, **kw):
            raise RuntimeError("database unavailable")

    _run_loop(fake, BrokenRepo(), stop)
    assert fake.ticks == 1


def test_static_path_traversal_is_refused(repo, dispatcher, tmp_path):
    # Directory traversal: `GET /..%2f<file>` must not serve a file outside static_dir.
    static = tmp_path / "dist"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<html>spa</html>")
    secret = tmp_path / "secret.txt"
    secret.write_text("SECRET")
    app = create_app(dispatcher.settings, repo, dispatcher, static_dir=static, run_loop=False)
    client = TestClient(app)
    r = client.get("/%2e%2e%2fsecret.txt")
    assert "SECRET" not in r.text
    r = client.get("/../secret.txt")
    assert "SECRET" not in r.text
    assert client.get("/board").text.endswith("<html>spa</html>")  # a normal SPA path works


def test_unknown_api_path_returns_json_404(tmp_path, repo, dispatcher):
    """The SPA fallback served index.html for any path, including /api/*: the client got a
    page instead of data, and it could only be diagnosed from the text of the JSON error."""
    static = tmp_path / "dist"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<html><head></head><body>dashboard</body></html>")

    client = TestClient(create_app(dispatcher.settings, repo, dispatcher,
                                   static_dir=static, run_loop=False))
    for path in ("/api/no-such-endpoint", "/api"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert response.json()["detail"]
    # A normal dashboard path still serves the page: routing happens on the React side.
    # `in`, not `==`: a <meta> tag with the token is injected into the page
    assert "dashboard" in client.get("/board/17").text
