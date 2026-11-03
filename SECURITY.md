# Security policy

## What orc is, security-wise

**orc runs code as you, without supervision. That is its job.** It starts Claude Code
sessions in your repositories and runs `verify_cmd` through `/bin/sh` in the task's
worktree. Sessions use the `auto` permission mode by default, and a project or task can be
switched to `bypassPermissions`. Anyone who can change orc's settings can run commands under
your account, so treat access to orc like access to your shell. In other words, reaching
the orc API is equivalent to remote code execution as the user who runs it.

This is the intended design, not a vulnerability. The sections below describe the threat
model so that you can tell the two apart.

## Threat model

- **Loopback only.** The server refuses to start on a non-loopback `--host` and rejects
  requests whose client address, `Host` or `Origin` header is not local. This covers other
  machines, DNS rebinding and other websites open in your browser. Never expose the port:
  no port forwarding, reverse proxy or tunnel.
- **The control room token does not protect against local processes.** Requests that change
  anything need a token. It is generated on the first start, stored in the data directory
  and embedded in the page served at `/`, so any process or user on the machine that can
  reach the port can read it. It is meant to stop requests from other web pages, not other
  processes on your machine. Read requests need no token: task descriptions and repository
  paths are visible to any local process.
- **`verify_cmd` runs code the agent may have just changed.** If it calls `make test`, the
  agent could have edited the Makefile in the same task. Running orc on an untrusted
  repository is like running its scripts yourself.
- **The Docker variant widens the blast radius.** `docker-compose.yml` mounts your entire
  home directory into the container read-write (`${HOME}:${HOME}`) and uses
  `network_mode: host`. The Dockerfile installs `@anthropic-ai/claude-code` without a pinned
  version, so every rebuild can bring a different CLI. Read `docker-compose.yml` before you
  use it.
- **Single user, single machine.** There are no accounts, roles or remote access. orc is
  not designed to be shared between people or run on a server.

## What to report

Please report, for example:

- a way for a remote site, another machine or a non-local `Host`/`Origin` to reach the API
  despite the loopback checks;
- a way to run commands or read files without the token where the token is supposed to be
  required, or to bypass the checks listed above;
- path traversal or similar issues that let a request touch files or repositories outside
  what a project is configured for;
- secrets (the token, tokens from Claude Code) leaking into logs, responses or the repository.

The following are known and documented behavior, not vulnerabilities: a local process
reading the token, `verify_cmd` executing arbitrary shell commands, sessions running in
`bypassPermissions` when you select it, and the Docker variant mounting `$HOME`.

## How to report a vulnerability

Please do not open a public issue.

Use GitHub's private vulnerability reporting:
<https://github.com/alimardonbegov/orc/security/advisories/new>
(the "Report a vulnerability" button on the repository's Security tab).

Include the orc version (`pyproject.toml` or the wheel name), your OS, what you did, what
you expected and what happened. A minimal reproduction helps most.

This is a small project maintained by one person, so I cannot promise a fixed response time.
I will read the report, confirm or explain, and publish a fix and an advisory once it is
ready.

## Supported versions

Only the latest release receives security fixes. Please check that the problem exists in the
latest version before reporting. Until 1.0, the minor version may contain breaking changes.
