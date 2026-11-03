# orc: installing from the package

orc is a kanban board for Claude Code that works through tasks on its own. A card from the
"To do" column gets its own git worktree, `claude --bg` is started in it, then your
verification command runs, and if it is green, the branch is merged into the target branch.
Everything runs locally through your Claude Code CLI and is billed to your subscription.

The package is a single file, `orc-<version>-py3-none-any.whl`. The interface is already
built into it, so you do not need a clone of the repository, Node.js or the Makefile.

## Prerequisites

- macOS or Linux.
- `git`.
- [`uv`](https://docs.astral.sh/uv/): `curl -LsSf https://astral.sh/uv/install.sh | sh`.
  It downloads Python 3.12+ by itself if needed.
- The Claude Code CLI in `PATH`, logged in with your subscription (run `claude` once and
  sign in). You need a version with background sessions, `claude --bg`; the check below
  will tell you.

## Installation

```bash
uv tool install ./orc-*.whl
uv tool update-shell     # if orc is not found: adds ~/.local/bin to PATH, restart the terminal
orc doctor               # checks git, claude, the --bg flag, the data directory and the interface
```

## Running

```bash
orc serve --open         # server and dispatcher, the browser opens at http://127.0.0.1:8765
```

The server lives as long as the terminal stays open. To keep it in the background:

```bash
nohup orc serve --log-file ~/.orc/orc.log > /dev/null 2>&1 &
```

For another port use `orc serve --port 9000`. The server listens on `127.0.0.1` only and
cannot be exposed to the network; this is deliberate, because the control room defines
commands that run with your privileges.

## First steps on the board

1. Add a project: the path to a local git repository, a verification command (`verify_cmd`,
   for example `make test` or `npm test`) and a limit of parallel tasks.
2. Create a card, fill in the "Task for the agent" field and drag it to "To do".
3. Within 30 seconds the dispatcher creates the branch `orc/task-<id>` in a worktree at
   `.claude/worktrees/orc-task-<id>` inside the repository and starts a session there. If the session asks a question, the card shows a "waiting for reply"
   badge, and your answer from the comment field goes to the same session.
4. When the verification passes, the task branch is merged into the target branch with
   `--no-ff`. Push is off by default and is switched on in the project settings.

Before you start, keep in mind:

- Sessions run in the `auto` permission mode by default. The mode is changed in the
  project settings and per task.
- Without a `verify_cmd` the merge trusts only the agent's report, so it is better to set a
  verification command.
- The interface comes in six languages (English by default); the default agent prompt and
  server messages are in English. You can replace the prompt in the settings
  ("Task prompt template").

## Where the data lives

`~/.orc/`: the `orc.db` database, the control room token and the limits cache. To keep them
elsewhere, set `ORC_DATA_DIR=/path`. Claude Code sessions write their jobs, as usual, to
`~/.claude/jobs`.

## Updating and uninstalling

```bash
uv tool install --force ./orc-*.whl    # update to the wheel in this directory, data is kept
uv tool uninstall orc                  # uninstall; remove ~/.orc by hand
```

## What the package does not include

Autostart at login (`make install-agent`), Docker and the development commands: all of
these work only from a clone of the repository.
