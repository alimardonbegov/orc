<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/public/brand/orc-mark-dark.svg">
    <img src="web/public/brand/orc-mark-light.svg" alt="orc logo" width="96" height="96">
  </picture>
</p>

<p align="center">
  <b>English</b> ·
  <a href="docs/readme/README.es.md">Español</a> ·
  <a href="docs/readme/README.fr.md">Français</a> ·
  <a href="docs/readme/README.de.md">Deutsch</a> ·
  <a href="docs/readme/README.pt.md">Português</a> ·
  <a href="docs/readme/README.ru.md">Русский</a>
</p>

# orc

**A task queue for Claude Code.** orc runs every task in its own git worktree with
`claude --bg`, checks the result with your own command and merges finished branches into
your branch one at a time.

[![CI](https://github.com/alimardonbegov/orc/actions/workflows/ci.yml/badge.svg)](https://github.com/alimardonbegov/orc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue.svg)

## Why orc

Doing a whole feature in one Claude Code session piles everything into one huge context.
orc lets you split the work into a queue of tasks instead, and gives every task a fresh
session of its own.

- **One task, one worktree.** Create task A and task B: orc starts each in its own git
  worktree through `claude --bg`, so sessions never share a context or a working copy.
- **FIFO merge, strictly one at a time.** Finished branches are merged into the target
  branch with `--no-ff`, in the order they became ready. A task that is ready while the
  branch is busy with another merge waits in the queue instead of failing.
- **Small conflicts, resolved by their author.** Each task branches off when it starts, so
  it already includes everything merged before it; together with one-at-a-time merges this
  keeps conflicts small. When one does happen, orc hands it back to the same session that
  wrote the code, because that session knows why the code looks the way it does.
- **Your own subscription.** Sessions run through your Claude Code CLI on your machine and
  count against the Claude subscription you already have. There is no separate credit pool.

orc is built for one developer without a reviewer: where a team would open pull requests,
your verification command decides what gets merged. Fill the queue in the evening, read
the result in the morning.

## Features

- **Kanban board** with Backlog, To do, In progress and Done. Everything that needs you (a
  question, a failure, a conflict) gathers in a "Waiting for me" strip above the board. Select several
  cards to change their status, priority, agent or labels at once, or archive them, and save a set of
  filters as a named view.
- **Auto-dispatcher.** You do not start tasks one by one: every 30 seconds (configurable)
  the dispatcher picks up tasks from "To do", within per-project and global worker limits
  and task dependencies. "Run now" triggers a pass without waiting for the timer.
- **Verify gate.** Your `verify_cmd` (tests, linter, build) runs in the task's worktree.
  Nothing is merged past a red check; a failure goes back to the session with the output.
- **Auto-merge without a pull request.** `git merge --no-ff` into the task's target
  branch, one task at a time. Push stays off until you enable it for a project.
- **Conflicts go back to the session that wrote the code**, up to three attempts, then to
  you.
- **Questions and live replies.** Permission requests, multiple-choice questions and plan
  approvals show up on the card; your answer goes into the same running session, usually
  within seconds. You can also send a message to a running session at any time.
- **Scheduled start.** "Not before" and an optional "Not after" time; a waiting task does
  not hold a worker slot.
- **Recurring routines.** An instruction plus a schedule (every N minutes, hours or days,
  or cron). Every run becomes an ordinary task with its own card, summary and token count.
  Routines have their own page in the left column and need no project: without one, each run is
  a chat with the agent.
- **Agents.** Save a model, effort, permission mode and an optional prompt under a name and an
  avatar, then allocate tasks and routines to it instead of setting parameters by hand. An agent
  does not belong to a project: it can work in all of them or be limited to one, and can keep its
  own memory across projects.
- **Chats and project leads.** Talk to an agent directly in a private worktree, where nothing is
  merged. A project's lead, appointed from the project's or the agent's settings, sees the board and
  proposes tasks, which reach the backlog only with your approval. See [docs/internals/agents.md](docs/internals/agents.md).
- **Agents that plan work.** A session, a chat or a project lead can split a large feature into linked
  cards with `orc task add`, `batch` and `link`, order them with dependencies and stages, hand in files,
  go to sleep with `orc task wakeup` until a time or another card is done, and be woken when all their
  subtasks finish. The dispatcher runs the chain by itself. See [docs/agent-tasks.md](docs/agent-tasks.md).
- **Token and quota tracking.** Each card shows the tokens of all its sessions and
  subagents, read from Claude Code transcripts. The sidebar shows your account's 5-hour
  and weekly limits. When a session hits the usage limit, the dispatcher pauses and
  resumes the task after the reset; after five quota retries in a row the task fails with
  an explanation.
- **Summary view.** Finished tasks and success rate, median work time, cost at API prices,
  how often sessions called you in, a forecast of your Claude limits, a timeline of
  finished tasks, tokens or cost, breakdowns by model, project, effort and permission
  mode, the distribution of task durations and the most expensive tasks.
- **Branch management from the UI.** Create, rename and delete branches; operations that
  would break running work are blocked with an explanation.
- **Rich task cards:** the assignment with screenshots pasted right into it, one
  conversation with the agent, a target branch, labels and planning dates, dependencies and
  subtasks with a dependency tree, and an execution log with every run, check and merge.
- **Six interface languages:** English, Spanish, French, German, Portuguese and Russian.
  Light and dark themes.

## How it works

1. **Add a project:** the path to a git repository, a `verify_cmd` and a worker limit.
2. **Create an agent and a task card:** write the assignment in "Task for the agent", assign the
   agent and move the card to "To do". An unassigned card stays with you: it does not go to work.
3. **The dispatcher picks it up:** it creates a worktree on a new branch `orc/task-N` from
   the task's target branch and starts `claude --bg` there with the assignment.
4. **Hand-in and verify:** the agent ends its work with `orc task done` (or
   `orc task fail`), and orc runs `verify_cmd` in the worktree. A failure goes back to the
   same session once; a second failure marks the task as failed. An agent that stops
   without handing in leaves the card waiting for you, with "Accept the work" at hand.
5. **Merge:** passing tasks are merged FIFO with `git merge --no-ff`, at most one per
   dispatcher pass. If the target branch is checked out in your main working copy, orc
   first commits your tracked changes there as a separate `wip(orc)` commit.
6. **Conflicts:** if the branch no longer merges cleanly, the same session merges the
   target branch into its own branch, resolves the conflict by meaning, passes
   verification again and goes to the back of the merge queue.
7. **Questions:** if a session asks something, the card gets a "waiting for reply" badge
   and your answer, typed in the card's conversation, is delivered into the same live
   session, without a restart.

The full walkthrough, including the merge rules and edge cases, is in
[docs/how-it-works.md](docs/how-it-works.md).

## Requirements

- macOS or Linux.
- Python 3.12 or newer and [uv](https://docs.astral.sh/uv/).
- Node.js 20.19+ on the 20.x line or 22.12+, with npm, to build the web UI (not needed
  for a wheel install).
- git 2.38 or newer (orc checks merges with `git merge-tree --write-tree`).
- The [Claude Code](https://github.com/anthropics/claude-code) CLI on your `PATH`,
  logged in, in a version that supports background sessions (`claude --bg`).
- Autostart at login is macOS-only (a LaunchAgent). On Linux, start the server yourself.

## Installation

### From a clone

```bash
git clone https://github.com/alimardonbegov/orc.git
cd orc
make setup        # uv sync, npm ci and a build of the web UI into web/dist
```

Data lives in `data/` inside the clone (SQLite, `orc.db`). Set `ORC_DATA_DIR` to keep it
somewhere else.

### From a wheel

`make package` builds a wheel with the web UI bundled in and puts it into `dist/` together
with `INSTALL.md`. The wheel installs with `uv tool install ./orc-*.whl` on any machine,
without a clone, Node.js or the Makefile, and keeps its data in `~/.orc`. See
[docs/install.md](docs/install.md).

### Docker (for experienced users)

`make docker-up` builds the image locally and starts a single container with the backend
and the web UI; `make docker-down` stops and removes it, and `make docker-restart` does
both in turn (`docker compose down`, then `docker compose up -d --build`, which may reuse
cached layers). Read `docker-compose.yml` before you use it:

- it mounts your **entire home directory** into the container, read-write
  (`${HOME}:${HOME}`), so the container sees `~/.claude` and your repositories at their
  usual paths;
- it uses `network_mode: host` (the container shares the host's network), because the
  server only listens on loopback;
- the Dockerfile installs `@anthropic-ai/claude-code` **without a pinned version**, so
  every rebuild can bring a different CLI;
- it uses the same `./data` directory and port 8765 as `make start`, so do not run both.

The Docker variant is provided as-is and is not covered by CI. For release 0.1.0 only the
image build was checked (on Docker Desktop for macOS: the image builds, and `orc doctor`
inside it passes); running the container with your home directory and `claude` login was
not tested. It relies on `network_mode: host`, which on Docker Desktop for macOS works only
if host networking is enabled in the Docker Desktop settings; otherwise the server is not
reachable on `127.0.0.1:8765`. The credentials of your host's `claude` login may not be
available inside the container on macOS, so prefer a clone or the wheel there.

## Quick start

```bash
uv run orc doctor   # checks Python, git, claude and its --bg flag, the data dir, the UI build
make start          # starts the server in the background
make stop           # stops it when you are done
```

Open <http://127.0.0.1:8765>, add a project, create a card and drag it to "To do".
Installed from a wheel? Run `orc doctor`, then `orc serve --open` (see
[docs/install.md](docs/install.md)).

| Command | What it does |
|---|---|
| `make start` / `make stop` / `make restart` | Run the server in the background (pid and log in `.run/`) |
| `make status` / `make logs` | Check that the server answers / follow its log |
| `make dev` | Run the server in the foreground and open the browser |
| `make build` | Rebuild the web UI |
| `make test` | Backend and frontend tests |
| `make package` | Build a wheel into `dist/` |
| `make install-agent` / `make uninstall-agent` / `make agent-status` | Autostart at login (macOS only) |

Run `make` without arguments to list every target. The port is set with
`make start PORT=9000`.

## CLI

From a clone, run the CLI as `uv run orc ...` or `.venv/bin/orc ...`; after a wheel
install, `orc` is on your `PATH`.

| Command | What it does |
|---|---|
| `orc serve [--host 127.0.0.1] [--port 8765] [--open] [--log-file PATH]` | Starts the web server and the dispatcher. `--open` opens the browser, `--log-file` (or `ORC_LOG_FILE`) adds a rotating log file. A non-loopback `--host` is refused. |
| `orc doctor` | Checks the environment without calling a model or creating anything. Exits with 1 if something blocks the dispatcher. |
| `orc tick` | Runs one dispatcher pass without the server, prints the dispatcher status and exits. Do not run it while `orc serve` is running: there is no lock between processes. |
| `orc db-path` | Prints the path to the database. |
| `orc task add\|batch\|link\|context\|guide\|install-skill` | Creates and links cards on the board of the running server, for agents and scripts: see [Agents creating tasks](docs/agent-tasks.md). |

## Security

**orc runs code as you, without supervision. That is its job.** It starts Claude Code
sessions in your repositories and runs `verify_cmd` through `/bin/sh` in the task's
worktree. Sessions use the `auto` permission mode by default, and a project or task can be
switched to `bypassPermissions`. Anyone who can change orc's settings can run commands
under your account, so treat access to orc like access to your shell.

- **Loopback only.** The server refuses to start on a non-loopback `--host` and rejects
  requests whose client address, `Host` or `Origin` header is not local, which covers
  other machines, DNS rebinding and other websites open in your browser. Never expose the
  port: no port forwarding, reverse proxy or tunnel.
- **The control room token does not protect against local processes.** Requests that
  change anything need a token. It is generated on the first start, stored in the data
  directory and embedded in the page served at `/`, so any process or user on the machine
  that can reach the port can read it. It is meant to stop requests from other web pages,
  not other processes on your machine. Read requests need no token at all: task
  descriptions and repository paths are visible to any local process.
- **`verify_cmd` runs code the agent may have just changed.** If it calls `make test`, the
  agent could have edited the Makefile in the same task. Running orc on an untrusted
  repository is like running its scripts yourself.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Limitations

- **Claude Code only, one machine, one person.** No other agents, accounts, remote access
  or team mode. The `plan` permission mode is not offered yet; see
  [docs/internals/plan-mode.md](docs/internals/plan-mode.md).
- **No diff review in the UI.** A result lands in your branch as a merge commit once
  `verify_cmd` passes; read the diff in git or your editor. Uncommitted tracked changes in
  a target branch checked out in your main working copy are committed before the merge.
- **Conflict detection is line-level.** Verification runs on the task's branch before it
  joins the queue, not on the merged result, so two tasks that change different files but
  depend on each other's behavior can merge cleanly and still break.
- **Quota detection is a heuristic.** A usage-limit failure is recognized by matching the
  session's failure text against regular expressions. The defaults have not been checked
  against a real limit error; tune them in Settings ("Quota-exhausted patterns").
- **Server text is English only.** The event feed, error details, CLI output and the
  default prompts are not localized; the interface is.

## Documentation

- [Agents creating tasks](docs/agent-tasks.md): letting a session put cards on the board,
  linked into a chain on one base branch.
- [How orc works](docs/how-it-works.md): the full flow, the merge queue, conflict
  resolution and edge cases.
- [Agents, leads, chats and memory](docs/internals/agents.md): how agents are resolved, what
  a chat is allowed to touch and how the optional memory works.
- [Installing from a wheel](docs/install.md).
- Internals: [task cards](docs/internals/task-cards.md),
  [input requests](docs/internals/input-requests.md),
  [handing in the work](docs/internals/handoff.md),
  [the execution log](docs/internals/execution-log.md),
  [message delivery](docs/internals/message-delivery.md),
  [plan mode](docs/internals/plan-mode.md).
- Design: [UI design decisions](docs/design/ui-design.md), [brand](docs/design/brand.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup and conventions; `make test` runs both test suites.

## License

[MIT](LICENSE)
