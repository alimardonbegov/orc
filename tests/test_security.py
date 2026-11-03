"""Dashboard perimeter: the API answers only this machine."""
import pytest

from orc.security import LoopbackOnlyMiddleware, is_allowed_host, is_allowed_origin

ALLOWED = ("127.0.0.1", "localhost", "::1")


def test_host_header_parsing():
    assert is_allowed_host("127.0.0.1:8765", ALLOWED)
    assert is_allowed_host("localhost", ALLOWED)
    assert is_allowed_host("[::1]:8765", ALLOWED)
    # DNS rebinding: the request comes from a loopback address, but under a foreign name
    assert not is_allowed_host("evil.example.com", ALLOWED)
    assert not is_allowed_host("evil.example.com:8765", ALLOWED)
    assert not is_allowed_host(None, ALLOWED)
    assert not is_allowed_host("", ALLOWED)


def test_origin_parsing():
    assert is_allowed_origin(None, ALLOWED)  # hook, curl: they do not send Origin
    assert is_allowed_origin("http://127.0.0.1:8765", ALLOWED)
    assert is_allowed_origin("http://localhost:5173", ALLOWED)  # vite dev
    assert not is_allowed_origin("https://evil.example.com", ALLOWED)
    assert not is_allowed_origin("null", ALLOWED)  # sandbox-iframe, file://


def test_check_names_the_failed_rule():
    mw = LoopbackOnlyMiddleware(None, allowed_hosts=ALLOWED, allowed_clients=("127.0.0.1",))
    ok = {"type": "http", "client": ("127.0.0.1", 1), "headers": [(b"host", b"127.0.0.1:8765")]}
    assert mw.check(ok) is None
    foreign_client = {**ok, "client": ("10.0.0.5", 1)}
    assert "10.0.0.5" in mw.check(foreign_client)
    foreign_host = {**ok, "headers": [(b"host", b"evil.example.com")]}
    assert "Host" in mw.check(foreign_host)
    foreign_origin = {**ok, "headers": [(b"host", b"127.0.0.1"), (b"origin", b"https://evil.example.com")]}
    assert "site" in mw.check(foreign_origin)


def test_foreign_host_is_rejected(client):
    response = client.get("/api/projects", headers={"host": "evil.example.com"})
    assert response.status_code == 403
    assert "Host" in response.json()["detail"]


def test_foreign_origin_is_rejected(client):
    response = client.get("/api/projects", headers={"origin": "https://evil.example.com"})
    assert response.status_code == 403


def test_own_origin_passes(client):
    response = client.get("/api/projects", headers={"origin": "http://127.0.0.1:8765"})
    assert response.status_code == 200


def test_foreign_client_address_is_rejected(repo, dispatcher):
    """The client address comes from the ASGI scope: we replace it right in the middleware."""
    from fastapi.testclient import TestClient

    from orc.server import create_app

    app = create_app(dispatcher.settings, repo, dispatcher, static_dir=None, run_loop=False)

    class ForeignClient:
        """ASGI wrapper: everything as with TestClient, but the client address is from the local network."""

        def __init__(self, inner):
            self.inner = inner

        async def __call__(self, scope, receive, send):
            if scope["type"] == "http":
                scope = {**scope, "client": ("192.168.1.20", 4242)}
            await self.inner(scope, receive, send)

    foreign = TestClient(ForeignClient(app))
    assert foreign.get("/api/projects").status_code == 403


def test_serve_refuses_non_loopback_host(tmp_path, monkeypatch):
    from orc.main import main

    # The data directory is under tmp_path: the refusal must happen BEFORE it is created, and the test checks this
    monkeypatch.setenv("ORC_DATA_DIR", str(tmp_path / "data"))
    with pytest.raises(SystemExit) as e:
        main(["serve", "--host", "0.0.0.0"])
    assert e.value.code == 2
    assert not (tmp_path / "data").exists()


def test_mutating_request_without_token_is_rejected(anon_client):
    r = anon_client.post("/api/dispatcher/pause")
    assert r.status_code == 403
    assert "reload the page" in r.json()["detail"]


def test_mutating_request_with_token_passes(client):
    """client uses the default token (see conftest): this is the dashboard's normal path."""
    assert client.post("/api/dispatcher/pause").status_code == 200


def test_get_needs_no_token(anon_client):
    """An attachment image is loaded by an <img> tag, a header cannot be attached there."""
    assert anon_client.get("/api/projects").status_code == 200


def test_hook_secret_does_not_open_owner_endpoints(anon_client, client, project, repo):
    """The hook secret is not the dashboard token: a session does not speak for the owner.

    This is the key test: it covers exactly what would let a session allow itself Bash.
    """
    t = client.post("/api/tasks", json={"project_id": project.id, "title": "t",
                                        "description": "d"}).json()
    repo.update_task(t["id"], status="in_progress", session_id="s-1", hook_secret="secret-a")
    created = anon_client.post("/api/hooks/input-requests",
                               json={"task_id": t["id"], "kind": "permission", "tool_name": "Bash"},
                               headers={"x-orc-hook": "secret-a"}).json()
    r = anon_client.post(f"/api/tasks/{t['id']}/input-requests/{created['id']}/answer",
                         json={"decision": {"behavior": "allow", "scope": "session"}},
                         headers={"x-orc-hook": "secret-a"})
    assert r.status_code == 403
    # The request is still waiting for the owner
    state = anon_client.get(f"/api/hooks/input-requests/{created['id']}",
                            headers={"x-orc-hook": "secret-a"}).json()["state"]
    assert state == "open"


def test_hook_endpoints_need_no_pult_token(anon_client, client, project, repo):
    t = client.post("/api/tasks", json={"project_id": project.id, "title": "t",
                                        "description": "d"}).json()
    repo.update_task(t["id"], status="in_progress", session_id="s-1", hook_secret="secret-a")
    r = anon_client.post("/api/hooks/input-requests",
                         json={"task_id": t["id"], "kind": "permission", "tool_name": "Bash"},
                         headers={"x-orc-hook": "secret-a"})
    assert r.status_code == 201


def test_index_html_carries_token_once(tmp_path, repo, dispatcher):
    import stat

    from fastapi.testclient import TestClient

    from orc.server import create_app

    static = tmp_path / "dist"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<html><head><title>orc</title></head><body>dashboard</body></html>")
    app = create_app(dispatcher.settings, repo, dispatcher, static_dir=static, run_loop=False)
    token = repo.get_setting("pult_token")
    assert token

    html = TestClient(app).get("/").text
    assert html.count("orc-token") == 1
    assert f'<meta name="orc-token" content="{token}">' in html
    assert "<title>orc</title>" in html  # the rest of the page is untouched

    copy = dispatcher.settings.data_dir / "pult-token"
    assert copy.read_text() == token
    assert stat.S_IMODE(copy.stat().st_mode) == 0o600
