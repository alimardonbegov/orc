"""Dashboard perimeter: the API answers only this machine.

The API can set verify_cmd (executed by a shell) and the prompt template (which goes to
the agent with the owner's privileges), so access to it equals code execution on this Mac.
There is deliberately no authentication from other machines: instead the server simply talks
to nobody but itself. Three checks close three different paths:

1. the client address: another machine on the network;
2. the Host header: DNS rebinding, where the request comes from a loopback address but under someone else's name,
   and the browser considers it its own;
3. the Origin header: a page of a third-party site opened in the same browser.

The dashboard token (X-Orc-Token) is inserted into <meta name="orc-token"> on GET /, so it
can be read by any local client. It protects against requests from the browser and third-party sites, but not
against processes of the same user and other users of the machine.

The middleware is a pure ASGI class, not BaseHTTPMiddleware: the latter reads the request body into memory
and breaks response streaming, while we need only the scope and headers.
"""
from __future__ import annotations

import logging
import os
import secrets
from pathlib import Path
from urllib.parse import urlsplit

from starlette.responses import JSONResponse

log = logging.getLogger("orc.security")

# Client addresses that count as "this machine". ::ffff:127.0.0.1 is IPv4 over an IPv6 socket.
LOOPBACK_ADDRESSES = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
# Names under which the dashboard may be opened (the Host header and the Origin host).
LOOPBACK_NAMES = ("127.0.0.1", "localhost", "::1")

PULT_TOKEN_FILE = "pult-token"
MUTATING_METHODS = {"POST", "PATCH", "PUT", "DELETE"}


def ensure_pult_token(repo, data_dir: Path) -> str:
    """Dashboard token: protection against browser requests (CSRF, DNS rebinding, third-party sites), not against
    local processes. Generated once and lives in the database; the copy in a file is not a second
    source of truth but a way to get the token by hand for curl when you are debugging something.

    Honestly about the strength of the protection: the token sits in <meta name="orc-token"> on GET /, and this endpoint is
    let through by all three perimeter checks, so any local client can read it,
    including an agent session (`curl http://127.0.0.1:8765/`). The token does not protect against processes of the same
    user and other users of the machine.
    """
    token = repo.get_setting("pult_token")
    if not token:
        token = secrets.token_urlsafe(32)
        repo.set_setting("pult_token", token)
    path = Path(data_dir) / PULT_TOKEN_FILE
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(token)
        os.chmod(path, 0o600)
    except OSError:
        log.warning("could not write a copy of the control room token to %s", path)
    return token


def _hostname(value: str) -> str:
    """Name without the port. `[::1]:8765` is parsed as IPv6, not as `[` and garbage."""
    value = value.strip()
    if value.startswith("["):
        return value[1:value.index("]")] if "]" in value else value
    return value.split(":", 1)[0]


def is_allowed_host(host_header: str | None, allowed: tuple[str, ...]) -> bool:
    if not host_header:
        return False
    return _hostname(host_header) in allowed


def is_allowed_origin(origin: str | None, allowed: tuple[str, ...]) -> bool:
    """A missing Origin means the request is not from a browser (hook, curl), which is normal.
    Origin "null" (sandbox iframe, file://) is not ours."""
    if origin is None:
        return True
    netloc = urlsplit(origin).netloc
    return bool(netloc) and _hostname(netloc) in allowed


class LoopbackOnlyMiddleware:
    def __init__(self, app, allowed_hosts: tuple[str, ...], allowed_clients: tuple[str, ...],
                 token: str | None = None):
        self.app = app
        self.allowed_hosts = allowed_hosts
        self.allowed_clients = allowed_clients
        self.token = token

    def check(self, scope: dict) -> str | None:
        """Refusal text, or None if the request is ours. A separate method so it can be tested without a network."""
        client = scope.get("client")
        address = client[0] if client else None
        if address is not None and address not in self.allowed_clients:
            return f"orc answers only on this machine, but the request came from {address}"
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        if not is_allowed_host(headers.get("host"), self.allowed_hosts):
            return "foreign Host header: orc can be opened only as 127.0.0.1 or localhost"
        if not is_allowed_origin(headers.get("origin"), self.allowed_hosts):
            return "the request came from a third-party site"
        # Fourth check: the dashboard token on mutating requests. It cuts off requests from the
        # browser and third-party sites, not local processes: the token is served on GET /. Hook
        # endpoints live by their own secret (X-Orc-Hook), not by the dashboard token.
        # Reads are open: an <img src> of attachments cannot carry the header.
        path = scope.get("path", "")
        if (self.token and scope.get("method") in MUTATING_METHODS
                and path.startswith("/api/") and not path.startswith("/api/hooks/")):
            got = headers.get("x-orc-token", "")
            if not secrets.compare_digest(got.encode("utf-8"), self.token.encode("utf-8")):
                return ("the control room did not send its token: reload the page (Cmd+R). "
                        "If that does not help, the server was restarted: open the control room again")
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        problem = self.check(scope)
        if problem is not None:
            await JSONResponse({"detail": problem}, status_code=403)(scope, receive, send)
            return
        await self.app(scope, receive, send)
