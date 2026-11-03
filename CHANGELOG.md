# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0 a
minor version may contain breaking changes.

## [Unreleased]

## [0.1.0] - 2026-11-03

Initial public release.

### Added

- Kanban board with Backlog, To do, In progress and Done, and a "Waiting for me" strip for
  everything that needs the user (a question, a failure, a conflict).
- Auto-dispatcher: picks up tasks from "To do" on a timer (30 seconds by default), within
  per-project and global worker limits and task dependencies; "Run now" triggers a pass
  immediately.
- One git worktree per task on a branch `orc/task-N`, with the session started through
  `claude --bg`.
- Verify gate: the project's `verify_cmd` runs in the task's worktree, and a failure goes
  back to the session with the output.
- Auto-merge without a pull request: `git merge --no-ff` into the task's target branch,
  FIFO and one task at a time; push is off until enabled per project.
- Conflict resolution by the session that wrote the code, up to three attempts, then it is
  handed to the user.
- Questions and live replies: permission requests, multiple-choice questions and plan
  approvals on the card, with answers delivered into the same running session; notes to a
  running session.
- Scheduled start with "Not before" and optional "Not after" times.
- Recurring routines: an instruction plus a schedule (every N minutes, hours or days, or
  cron), each run becoming an ordinary task.
- Token and quota tracking: tokens per card read from Claude Code transcripts, the account's
  5-hour and weekly limits in the sidebar, pause and resume of the dispatcher on a usage
  limit.
- Summary view with finished tasks and success rate, median work time, cost at API prices, a
  forecast of Claude limits, a timeline and breakdowns by model, project, effort and
  permission mode.
- Branch management from the UI: create, rename and delete branches, with operations that
  would break running work blocked.
- Task cards with model, effort and permission mode, a target branch, dependencies on other
  tasks and screenshots pasted into the assignment.
- Six interface languages (English, Spanish, French, German, Portuguese and Russian) and
  light and dark themes.
- CLI: `orc serve`, `orc doctor`, `orc tick` and `orc db-path`.
- Installation from a clone (`make setup`), from a wheel (`make package`) and with Docker.
- Autostart at login on macOS (LaunchAgent).

[Unreleased]: https://github.com/alimardonbegov/orc/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alimardonbegov/orc/releases/tag/v0.1.0
