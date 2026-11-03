# Contributing to orc

Thanks for your interest. Issues and pull requests are welcome. orc is a small project
maintained by one person, so please keep changes focused.

Before you start, read the [Security](README.md#security) section of the README: orc runs
code as you by design, and that affects how you should test it.

## Supported platforms

macOS and Linux. Windows is not supported. Autostart at login (LaunchAgent) is macOS-only.
You need Python 3.12 or newer, [uv](https://docs.astral.sh/uv/), Node.js 20.19+ on the 20.x
line or 22.12+ (the same range as in the README; CI uses 22), git 2.38 or newer and, to run
the whole thing for real, the [Claude Code](https://github.com/anthropics/claude-code) CLI.

## Getting started

```bash
git clone https://github.com/alimardonbegov/orc.git
cd orc
make setup        # uv sync, npm ci and a build of the web UI into web/dist
make test         # backend (pytest) and frontend (vitest) tests
```

Useful targets: `make dev` runs the server in the foreground and opens the browser,
`make build` rebuilds the web UI, `make package` builds a wheel into `dist/`. Run `make`
without arguments to list everything.

The checks that CI runs, so you can run them before you push:

```bash
uv sync --locked && uv run pytest -q        # backend
cd web && npm ci && npm run lint && npm test && npm run build   # frontend
```

The backend tests do not need a real `claude` binary.

### Working with `claude --bg` locally

Running orc for real needs a Claude Code CLI on your `PATH`, logged in, in a version that
supports background sessions (`claude --bg`). Run `uv run orc doctor` first: it checks
Python, git, `claude` and its `--bg` flag, the data directory and the UI build without
calling a model or creating anything.

When you try your changes against real sessions, use a throwaway git repository as the
project, and keep the permission mode on `auto`. Do not point orc at repositories you care
about while testing unfinished code, and never expose the port (see
[SECURITY.md](SECURITY.md)). By default data lives in `data/` inside the clone; set
`ORC_DATA_DIR` to use a separate directory for experiments.

## Branches and pull requests

The model is trunk-based:

- `main` is the only long-lived branch and should always be green.
- Work happens in short-lived branches named `feat/kanban-filters`, `fix/merge-retry`
  or `docs/install-guide` (a type prefix and a short name).
- Open a pull request into `main`. Only squash merge is used, so the PR title becomes the
  commit message on `main`.
- The PR title follows [Conventional Commits](https://www.conventionalcommits.org/):
  `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`, `refactor: ...`, `test: ...`, with an
  optional scope such as `fix(merge): ...`.
- Add or update tests for behavior changes, and add a line to `CHANGELOG.md` under
  `[Unreleased]` for anything a user would notice.
- CI (backend tests, frontend lint, tests and build) must be green.

For a larger change, please open an issue first to agree on the approach.

## Code style

- Code comments, docstrings and commit messages are in English.
- Names of classes, variables and functions are in English.
- `.editorconfig` sets the basics: UTF-8, LF, a final newline, 4 spaces in Python and 2 in
  TypeScript, JSON, YAML, CSS and HTML.
- The web UI is linted with `npm run lint` (oxlint) and type-checked as part of
  `npm run build`.

## Versions and releases

Versions follow [Semantic Versioning](https://semver.org/). Before 1.0 a minor version may
contain breaking changes. The single source of the version is `pyproject.toml`.

A release is made by the maintainer:

1. Bump `version` in `pyproject.toml`.
2. In `CHANGELOG.md`, move the `[Unreleased]` entries under a new `## [X.Y.Z] - date`
   heading and update the links at the bottom.
3. Merge that change into `main` through a pull request.
4. Create an annotated tag on the merge commit: `git tag -a vX.Y.Z -m "vX.Y.Z"`, then push
   the tag.
5. Run `make package` and create a GitHub Release from the tag with the wheel from `dist/`
   attached.

## Repository settings for the maintainer

These are configured on GitHub and cannot be stored in the repository:

- A ruleset for `main`: pull request and green CI required, force-push blocked, bypass for
  the owner.
- Only squash merge enabled.
- Private vulnerability reporting enabled (it is how [SECURITY.md](SECURITY.md) asks people
  to report problems).
- Dependabot enabled (its configuration is in `.github/dependabot.yml`), plus repository
  topics and description.

## Reporting security problems

Please do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the [MIT](LICENSE)
license of this project.
