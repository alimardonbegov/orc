"""`orc` entry point: serve | tick | db-path | doctor | task."""
from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import shutil
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

from orc import security, task_cli
from orc.claude_cli import ClaudeCli
from orc.config import Settings, default_data_dir, default_static_dir, load_settings, running_from_source
from orc.db import connect, init_schema
from orc.dispatcher import Dispatcher
from orc.repo import Repo

LOG_FORMAT = "%(asctime)s %(name)s %(levelname)s %(message)s"
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUPS = 3


class PrivateRotatingFileHandler(logging.handlers.RotatingFileHandler):
    """Rotation plus 0600 permissions on every log file: it contains task submissions and repository paths."""

    def _open(self):
        # RotatingFileHandler reopens the file after every rotation exactly through _open,
        # so permissions are set here, not once from outside. fchmod also fixes a file that
        # was already lying around with 0644 from before this version.
        fd = os.open(self.baseFilename, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.fchmod(fd, 0o600)
        return open(fd, self.mode, encoding=self.encoding)


def setup_logging(path: str | None) -> logging.Handler | None:
    """Logs to stdout and, if a path is given, also to a file with rotation.

    Previously the Makefile wrote the file through `nohup >> .run/orc.log`, and rotation could not exist
    in principle: shell redirection knows nothing about file size.
    """
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    if not path:
        return None
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    handler = PrivateRotatingFileHandler(path, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUPS,
                                         encoding="utf-8")
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    logging.getLogger().addHandler(handler)
    return handler


def build_runtime(settings: Settings) -> tuple[Repo, Dispatcher]:
    conn = connect(settings.db_path)
    init_schema(conn)
    repo = Repo(conn)
    cli = ClaudeCli(bin=settings.claude_bin, jobs_dir=settings.jobs_dir)
    return repo, Dispatcher(repo, settings, cli)


def _run(cmd: list[str]) -> tuple[bool, str]:
    """Output of a short helper command; a launch error just means "does not work"."""
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    return done.returncode == 0, (done.stdout or done.stderr).strip()


def doctor(claude_bin: str = "claude") -> int:
    """Environment check before the first run, for someone installing orc from a package.

    Creates nothing and does not call the model: only --version/--help of external programs,
    otherwise the check would spend subscription limits. Returns the exit code: 1 if there is
    at least one problem without which the dispatcher cannot work."""
    problems = 0

    def line(ok: bool, what: str, detail: str) -> None:
        nonlocal problems
        problems += not ok
        print(f"  [{'ok' if ok else '!!'}] {what}: {detail}")

    print("orc doctor")
    line(sys.version_info >= (3, 12), "python", sys.version.split()[0])
    ok, out = _run(["git", "--version"]) if shutil.which("git") else (False, "not found in PATH")
    line(ok, "git", out)
    path = shutil.which(claude_bin)
    if path is None:
        line(False, "claude", "not found in PATH: install the Claude Code CLI and log in (`claude`)")
    else:
        ok, out = _run([path, "--version"])
        line(ok, "claude", f"{out} ({path})")
        # The dispatcher launches tasks through `claude --bg`: older CLI versions do not have it
        ok, out = _run([path, "--help"])
        line(ok and "--bg" in out, "claude --bg",
             "available" if ok and "--bg" in out else "missing from `claude --help`: update Claude Code")
    env_dir = os.environ.get("ORC_DATA_DIR")
    data_dir = Path(env_dir) if env_dir else default_data_dir()
    line(True, "data", f"{data_dir}" + (" (ORC_DATA_DIR)" if env_dir else ""))
    static = default_static_dir()
    has_ui = (static / "index.html").is_file()
    hint = "make build" if running_from_source() else "the package was built without the UI, a new wheel is needed"
    line(has_ui, "UI", f"{static}" if has_ui else f"no build in {static} — {hint}")
    print("all set: orc serve --open" if not problems else f"problems: {problems}")
    return 1 if problems else 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="orc", description="Task orchestrator for Claude Code")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="start the server and the dispatcher")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--open", action="store_true", help="open the browser")
    serve.add_argument("--log-file", default=os.environ.get("ORC_LOG_FILE"),
                       help="log file with rotation; without it the log goes only to stdout")
    sub.add_parser("tick", help="run one dispatcher pass and exit")
    sub.add_parser("db-path", help="print the database path")
    sub.add_parser("doctor", help="check the environment: git, claude, data directory, UI")
    task_cli.add_parser(sub)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    setup_logging(getattr(args, "log_file", None))
    if args.command == "serve" and args.host not in security.LOOPBACK_NAMES:
        print(f"orc listens only on this machine: --host {args.host} is not allowed.\n"
              f"The API sets verify_cmd and the prompt template, which means code execution "
              f"with your privileges, so it must not be exposed to the network.", file=sys.stderr)
        raise SystemExit(2)
    if args.command == "doctor":
        # Before load_settings: the check must not create the data directory
        raise SystemExit(doctor())
    if args.command == "task":
        # Before load_settings as well: a client of the server must not create a data directory or open the database
        raise SystemExit(task_cli.run(args))
    settings = load_settings()
    if args.command == "db-path":
        print(settings.db_path)
        return
    repo, dispatcher = build_runtime(settings)
    if args.command == "tick":
        dispatcher.tick()
        # A one-shot pass must run the checks to the end: otherwise `orc tick` would return
        # the task to verifying and exit, with nobody left to collect the result.
        dispatcher.verify_pool.wait()
        dispatcher.tick()
        dispatcher.verify_pool.shutdown()
        print(dispatcher.status())
        return
    import uvicorn
    from orc.server import create_app

    # Session hooks go to this same server for the owner's decisions: the address must match
    # the one it actually listens on, not the default from Settings.
    hook_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    settings.api_base = f"http://{hook_host}:{args.port}"
    app = create_app(settings, repo, dispatcher)
    task_cli.write_server_url(settings.data_dir, settings.api_base)
    if args.open:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://{args.host}:{args.port}")).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
