"""Typing into a live background session, the way a person does in a terminal.

`claude attach <id>` opens the session's own input box. Whatever is typed there goes through the same path as
console input: an idle session starts a turn at once, a busy one queues the message and absorbs it at its next
step, and Esc interrupts the current action while the process, the job and the background work stay. So this
channel needs no stop, no resume and no copy of the session, and works whether the agent is calling tools or not.

The driver holds a pseudo-terminal for the few seconds it takes to type, then detaches. Measured on Claude Code
2.1.319, see docs/internals/message-delivery.md.
"""
from __future__ import annotations

import os
import re
import select
import struct
import subprocess
import time
from typing import Callable

# What the input box and the option list of a dialog are drawn with. The client paints nothing useful before it.
READY_MARKER = "❯".encode()
READY_TIMEOUT_SEC = 10
# After the marker the client still wires up the input handler: keys sent right away are lost.
SETTLE_SEC = 0.5
ESC_SETTLE_SEC = 0.8
# How long the client stays attached so that a lone Esc reaches the session.
INTERRUPT_LINGER_SEC = 1.5
SUBMIT_SETTLE_SEC = 0.4
CONFIRM_TIMEOUT_SEC = 8.0
DETACH_TIMEOUT_SEC = 2.0
WRITE_TIMEOUT_SEC = 30.0

ESC = b"\x1b"
ENTER = b"\r"
# Alt+Enter: a line break inside the input box. A bare CR would submit the message.
LINE_BREAK = "\x1b\r"
# Typed in small pieces: the input box treats a large single read as a paste, and pastes of about 800 characters
# or more reach the model wrapped in <pasted_content>, as material from elsewhere rather than the owner's words.
TYPE_CHUNK_CHARS = 32
TYPE_CHUNK_DELAY_SEC = 0.006
# Ctrl+U deletes up to the start of the line. Unsubmitted text outlives the client that typed it.
CLEAR_LINE = b"\x15"
CLEAR_MARGIN = 4
TERMINAL_WRAP_CHARS = 40
TERMINAL_ROWS = 45
TERMINAL_COLUMNS = 140

# At the very start of the input box these switch it into a mode (a slash command, shell mode, ...). A leading
# space keeps the text a plain message, which is what it was when it went through a prompt or a hook.
_MODE_PREFIXES = ("/", "!", "#", "&")
_LINE_END_BACKSLASH = re.compile(r"\\$", re.MULTILINE)
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_TERMINAL_CODES = re.compile(rb"\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]")
# Claude Code reads these from its own parent session: a client inheriting them believes it is nested.
_INHERITED_ENV = ("CLAUDECODE", "CLAUDE_PID", "CLAUDE_JOB_DIR")
_INHERITED_ENV_PREFIX = "CLAUDE_CODE_"


class SessionInputError(RuntimeError):
    """The session's input box could not be reached. Nothing was submitted."""


def prepare_text(text: str) -> str:
    """Owner text -> what is safe to type.

    Control characters are dropped, ESC above all: typed raw it would act as a key, and a stray Esc interrupts the
    agent. Tabs become spaces, since Tab accepts a completion. A backslash at the end of a line gets a space after
    it: backslash + Enter means a line break, so the last line would never be submitted, and the box eats a
    backslash in front of a line break.
    """
    clean = text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", "  ")
    clean = _LINE_END_BACKSLASH.sub(r"\\ ", _CONTROL.sub("", clean).strip())
    return f" {clean}" if clean.startswith(_MODE_PREFIXES) else clean


def keystrokes(text: str) -> list[bytes]:
    """Prepared text as the chunks to write, never splitting a character."""
    typed = text.replace("\n", LINE_BREAK)
    return [typed[i:i + TYPE_CHUNK_CHARS].encode() for i in range(0, len(typed), TYPE_CHUNK_CHARS)]


def _clearing_keys(text: str) -> bytes:
    """Enough Ctrl+U to empty the input box of this text, whichever way it was wrapped on screen. On an empty box
    they do nothing."""
    return CLEAR_LINE * (2 * text.count("\n") + len(text) // TERMINAL_WRAP_CHARS + CLEAR_MARGIN)


def _client_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items()
           if k not in _INHERITED_ENV and not k.startswith(_INHERITED_ENV_PREFIX)}
    env["TERM"] = "xterm-256color"
    return env


class _Terminal:
    """A `claude attach` client on a pseudo-terminal. Its output has to keep being read, or it stalls."""

    def __init__(self, bin: str, job_id: str):
        try:
            import fcntl
            import pty
            import termios
        except ImportError as e:  # no pseudo-terminals on this platform: the caller has other channels
            raise SessionInputError(f"no pseudo-terminal on this platform: {e}")
        self.output = b""
        master, slave = pty.openpty()
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", TERMINAL_ROWS, TERMINAL_COLUMNS, 0, 0))
            os.set_blocking(master, False)
            self.proc = subprocess.Popen([bin, "attach", job_id], stdin=slave, stdout=slave, stderr=slave,
                                         env=_client_env(), start_new_session=True, close_fds=True)
        except OSError as e:
            os.close(master)
            raise SessionInputError(f"could not start `{bin} attach`: {e}")
        finally:
            os.close(slave)
        self.master = master

    def _read_available(self, wait: float) -> None:
        ready, _, _ = select.select([self.master], [], [], wait)
        if not ready:
            return
        try:
            data = os.read(self.master, 65536)
        except BlockingIOError:
            return
        except OSError:  # EIO: the client exited and the terminal is gone
            data = b""
        if data:
            self.output += data
        elif self.proc.poll() is None:
            time.sleep(wait)

    def wait(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while (left := end - time.monotonic()) > 0:
            self._read_available(min(left, 0.05))

    def wait_ready(self) -> None:
        end = time.monotonic() + READY_TIMEOUT_SEC
        while READY_MARKER not in self.output:
            if self.proc.poll() is not None:
                raise SessionInputError(f"`claude attach` exited: {self.screen_tail()}")
            if time.monotonic() > end:
                raise SessionInputError(f"the session's input box did not appear within {READY_TIMEOUT_SEC} s")
            self._read_available(0.05)
        self.wait(SETTLE_SEC)

    def write(self, data: bytes) -> None:
        end = time.monotonic() + WRITE_TIMEOUT_SEC
        while data:
            if self.proc.poll() is not None:
                raise SessionInputError(f"`claude attach` exited while typing: {self.screen_tail()}")
            try:
                data = data[os.write(self.master, data):]
            except BlockingIOError:
                if time.monotonic() > end:
                    raise SessionInputError("the session's input box stopped accepting keys")
            except OSError as e:
                raise SessionInputError(f"the session's terminal is gone: {e}")
            self._read_available(0.0)

    def wait_for(self, confirm: Callable[[], bool], timeout: float) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if confirm():
                return True
            self.wait(0.25)
        return confirm()

    def screen_tail(self) -> str:
        return _TERMINAL_CODES.sub(b" ", self.output).decode("utf-8", "replace").strip()[-200:]

    def close(self) -> None:
        """Detach. The session does not depend on its clients and keeps running."""
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(DETACH_TIMEOUT_SEC)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        os.close(self.master)


def type_message(bin: str, job_id: str, text: str, interrupt: bool, confirm: Callable[[], bool]) -> bool:
    """Type a message into a live session and submit it. True once `confirm` sees it arrive.

    interrupt: press Esc first, as a person does when the agent should drop what it is doing or a dialog is open.
    Enter on an open dialog would pick its highlighted option instead of sending the message.
    """
    terminal = _Terminal(bin, job_id)
    try:
        terminal.wait_ready()
        if interrupt:
            terminal.write(ESC)
            terminal.wait(ESC_SETTLE_SEC)
        typed = prepare_text(text)
        for chunk in keystrokes(typed):
            terminal.write(chunk)
            terminal.wait(TYPE_CHUNK_DELAY_SEC)
        terminal.wait(SUBMIT_SETTLE_SEC)
        terminal.write(ENTER)
        received = terminal.wait_for(confirm, CONFIRM_TIMEOUT_SEC)
        if not received:
            # The text may still sit in the box. It would stick to the next attempt or to the owner's next
            # message, and it must not go out on its own after the message has taken another channel.
            terminal.write(_clearing_keys(typed))
            terminal.wait(SUBMIT_SETTLE_SEC)
        return received
    finally:
        terminal.close()


def press_interrupt(bin: str, job_id: str) -> None:
    """Esc in the session's terminal: stop the current action and keep everything else, like in a console."""
    terminal = _Terminal(bin, job_id)
    try:
        terminal.wait_ready()
        terminal.write(ESC)
        terminal.wait(INTERRUPT_LINGER_SEC)
    finally:
        terminal.close()
