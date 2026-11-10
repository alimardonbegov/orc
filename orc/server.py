"""Assembling the FastAPI application: the API, the frontend static files, the background dispatcher thread."""
from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager
from html import escape as html_escape
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from orc.api import router
from orc import quick_create
from orc.config import Settings, default_static_dir
from orc.dispatcher import Dispatcher, DispatcherBusy
from orc.repo import Repo
from orc.security import LoopbackOnlyMiddleware, ensure_pult_token
from orc.usage import Prober

log = logging.getLogger("orc.server")
DEFAULT_STATIC = default_static_dir()


def _poll_interval(repo: Repo, fallback: int) -> int:
    """Poll interval from the settings, with a safe fallback.

    Anything can end up in the setting (validation appeared later than the setting), and the interval
    is parsed in the dispatcher thread: a ValueError here used to kill the thread forever, and
    the board silently stalled while the API cheerfully said `paused: false`.
    """
    try:
        return max(5, int(repo.get_setting("poll_interval_sec", str(fallback))))
    except Exception:
        log.warning("poll_interval_sec is invalid, using %s s", fallback)
        return max(5, fallback)


def _run_loop(dispatcher: Dispatcher, repo: Repo, stop: threading.Event) -> None:
    fallback = dispatcher.settings.poll_interval_sec
    while not stop.is_set():
        try:
            dispatcher.tick()
        except Exception:
            log.exception("tick failed")
        stop.wait(_poll_interval(repo, fallback))


def _reprice(dispatcher: Dispatcher) -> None:
    try:
        dispatcher.reprice_usage()
    except Exception:
        log.exception("recomputing costs with the new price list failed")


def create_app(settings: Settings, repo: Repo, dispatcher: Dispatcher,
               static_dir: Path | None = DEFAULT_STATIC, run_loop: bool = True) -> FastAPI:
    stop = threading.Event()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        # The dispatcher thread lives as long as the server
        if run_loop:
            threading.Thread(target=_run_loop, args=(dispatcher, repo, stop), daemon=True, name="orc-dispatcher").start()
            # Recalculating money at the new price list reads the transcripts of all tasks (seconds to a minute),
            # so it runs in the background: the board must not wait for it to open.
            threading.Thread(target=_reprice, args=(dispatcher,), daemon=True, name="orc-reprice").start()
            # Chats poll their sessions far more often than the dispatcher pass runs, so they get a thread of their own
            threading.Thread(target=dispatcher.chats.run, args=(stop,), daemon=True, name="orc-chats").start()
        yield
        stop.set()
        # We close the pool together with the server, killing running checks: otherwise the interpreter
        # at exit would wait for worker threads, and make stop would hang until the end of make test.
        dispatcher.verify_pool.shutdown()

    app = FastAPI(title="orc", lifespan=lifespan)
    token = ensure_pult_token(repo, settings.data_dir)
    app.add_middleware(LoopbackOnlyMiddleware, allowed_hosts=settings.allowed_hosts,
                       allowed_clients=settings.allowed_clients, token=token)

    # One handler instead of an except branch in every endpoint: the dispatcher command is called by eight
    # handlers, and whoever adds the ninth will not remember about the 409.
    @app.exception_handler(DispatcherBusy)
    async def _busy(_: Request, e: DispatcherBusy):
        return JSONResponse({"detail": str(e)}, status_code=409)

    app.state.repo = repo
    app.state.dispatcher = dispatcher
    app.state.settings = settings
    # One limits probe per application: the probe has a cooldown and protection against parallel
    # runs, and they work only while the object is shared by all requests (orc/usage.py).
    app.state.prober = Prober(settings.usage_cache_path, claude_bin=settings.claude_bin,
                              cwd=settings.data_dir, enabled=settings.usage_probe_enabled)
    # What writes a card draft (orc/quick_create.py): replaced by tests, the model is a paid request
    app.state.drafter = quick_create.run_claude(settings.claude_bin)
    app.include_router(router)

    if static_dir is not None and not (static_dir / "index.html").is_file():
        # Without a build the server is alive, but serves a bare 404 on /: you cannot tell that silently
        log.warning("no built UI in %s: the control room will not open. In a clone run make build; "
                    "for a package, rebuild the wheel with make package", static_dir)
    if static_dir is not None and static_dir.exists():
        app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")

        root = static_dir.resolve()

        @app.get("/{path:path}")
        def spa(path: str):
            # An unknown API endpoint is an error, not a page. Previously any /api/* missing from
            # the router fell through here, and the client got index.html with status
            # 200: such a thing could be diagnosed only by the text of the JSON parse error.
            if path == "api" or path.startswith("api/"):
                raise HTTPException(404, f"no such API endpoint: /{path}")
            # Any non-API path serves index.html: routing is on the React side.
            # resolve() + is_relative_to: without normalization `..` in the path serves files outside
            # the build directory (directory traversal).
            candidate = (root / path).resolve()
            if path and candidate.is_relative_to(root) and candidate.is_file():
                return FileResponse(candidate)
            # The token goes into <meta> when the page is served: this way it ends up neither in the browser
            # history nor in localStorage, from where any script on the same port could read it.
            html = (root / "index.html").read_text(encoding="utf-8")
            meta = f'<meta name="orc-token" content="{html_escape(token, quote=True)}">'
            html = html.replace("</head>", meta + "</head>", 1) if "</head>" in html else meta + html
            return HTMLResponse(html)

    return app
