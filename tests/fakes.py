"""Fake claude CLI for dispatcher tests: no processes, the state is set by the test."""
from __future__ import annotations

from pathlib import Path

from orc.claude_cli import ClaudeCliError, JobState

# Sentinel for set_state: tells "session_id not passed" apart from "session_id explicitly None"
KEEP = object()


class FakeClaudeCli:
    def __init__(self):
        self.calls: list[tuple] = []
        self.states: dict[str, JobState] = {}
        self.next_ids: list[str] = []
        self.read_state_calls: list[str] = []
        # delay_state=True reproduces the real daemon behaviour: right after launch
        # state.json is not written yet, read_state returns None and session_id is unknown.
        self.delay_state = False
        # True: claude stop moves the session to stopped immediately (the daemon managed to confirm)
        self.stop_marks_stopped = False
        # The transcript each new session will get (token collection tests); None means unknown
        self.transcript_for_new: str | None = None
        # Daemon sessions that are not in the orc journal (started by the owner by hand)
        self.foreign_sessions: list[dict] = []
        # True: `claude agents --json` is unavailable
        self.sessions_error = False
        self._counter = 0

    def list_sessions(self) -> list[dict]:
        if self.sessions_error:
            raise ClaudeCliError("claude agents is unavailable")
        own = [{"id": job, "kind": "background", "state": st.state} for job, st in self.states.items()
               if st.state not in ("stopped", "done", "failed")]
        return own + list(self.foreign_sessions)

    def _new_id(self) -> str:
        if self.next_ids:
            return self.next_ids.pop(0)
        self._counter += 1
        return f"job{self._counter:05d}"

    def start_bg(self, cwd, prompt, name, model=None, effort=None, permission_mode="auto",
                 settings=None) -> str:
        job = self._new_id()
        self.calls.append(("start_bg", str(cwd), prompt, name, model, effort, permission_mode, settings))
        if not self.delay_state:
            self.states.setdefault(job, JobState("working", "", None, f"sess-{job}", None, self.transcript_for_new))
        return job

    def resume_bg(self, cwd, session_id, prompt, settings=None) -> str:
        # Same contract as the real ClaudeCli.resume_bg: without a session_id there is nothing to resume
        if not session_id:
            raise ClaudeCliError("resume without session_id: nothing to resume")
        job = self._new_id()
        self.calls.append(("resume_bg", str(cwd), session_id, prompt, settings))
        if not self.delay_state:
            self.states.setdefault(job, JobState("working", "", None, session_id, None, self.transcript_for_new))
        return job

    def stop(self, job_id) -> None:
        self.calls.append(("stop", job_id))
        # The daemon does not confirm a stop instantly. By default the fake
        # behaves as "did not make it in time": this is the worst case, which checks
        # that the dispatcher does not resume a session without confirmation.
        if self.stop_marks_stopped and job_id in self.states:
            old = self.states[job_id]
            self.states[job_id] = JobState("stopped", "stopped", None, old.session_id, None, old.transcript_path)

    def remove(self, job_id) -> None:
        self.calls.append(("remove", job_id))

    def read_state(self, job_id) -> JobState | None:
        self.read_state_calls.append(job_id)
        return self.states.get(job_id)

    # Test helper: move a job to a state.
    # session_id=None is set explicitly (the session never became known), a string is a changed session.
    def set_state(self, job_id, state, detail="", needs=None, session_id=KEEP, transcript_path=KEEP, tempo=None,
                  in_flight=0, queued=0, timers=0):
        old = self.states.get(job_id)
        if session_id is KEEP:
            session_id = old.session_id if old else f"sess-{job_id}"
        if transcript_path is KEEP:
            transcript_path = old.transcript_path if old else None
        self.states[job_id] = JobState(state, detail, needs, session_id, None, transcript_path, tempo, in_flight,
                                       queued, timers)

    def drop_state(self, job_id) -> None:
        """The state.json file is gone: `claude rm` or cleanup of old jobs."""
        self.states.pop(job_id, None)
