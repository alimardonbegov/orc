# Managing the orc server: build, background start/stop, autostart at macOS login.
# All paths are absolute: the Makefile is also invoked from launchd, where the current directory is not ours.
#
# Two rules that are easy to break here:
#  1. Every recipe line is a separate shell, so `exit 0` in a check does NOT abort the
#     recipe: the following lines still run. All recipes with checks are written as a
#     single block using `set -e` and line continuations.
#  2. The server is started directly from .venv, not via `uv run`: the latter stays as a
#     parent wrapper and ITS pid ends up in the pid file, so killing that pid leaves an
#     orphaned server that keeps holding the port.

SHELL := /bin/bash
ROOT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

HOST ?= 127.0.0.1
PORT ?= 8765
# Runtime files (pid, log) are kept apart from data/: data/ holds data, this holds process state
RUN_DIR := $(ROOT)/.run
PID_FILE := $(RUN_DIR)/orc.pid
LOG_FILE := $(RUN_DIR)/orc.log
# The server writes the log itself (rotation 5 MB x 3, see orc/main.py). stdout.log only gets
# what is printed outside the logger: a startup crash trace, uvicorn messages before setup.
STDOUT_FILE := $(RUN_DIR)/stdout.log

UV := $(shell command -v uv 2>/dev/null)
BIN := $(ROOT)/.venv/bin/orc
LABEL := dev.orc.server
PLIST := $(HOME)/Library/LaunchAgents/$(LABEL).plist

.DEFAULT_GOAL := help
.PHONY: help setup deps-web build start stop restart status logs dev test test-py test-web \
        install-agent uninstall-agent agent-status \
        package \
        docker-up docker-down docker-restart

# Is the process from the pid file alive: a shell condition for use inside recipes
ALIVE = [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null

# Frontend dependencies count as installed while npm's node_modules snapshot is not older
# than package-lock.json. Checking only that the directory exists is not enough: after a pull
# or merge that brings new packages, node_modules stays stale and the build fails with an
# obscure TS2307 "Cannot find module" error instead of installing them.
NPM_STAMP := $(ROOT)/web/node_modules/.package-lock.json

help:  ## Show the list of commands
	@echo "orc: management commands"
	@echo
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Variables: HOST=$(HOST) PORT=$(PORT)"

# ---------- setup ----------

setup: ## Install dependencies (Python + frontend) and build the SPA
	@if [ -z "$(UV)" ]; then echo "uv not found: install uv (see Requirements in README.md) or set UV=<path>"; exit 1; fi
	cd $(ROOT) && $(UV) sync
	$(MAKE) deps-web
	$(MAKE) build

# npm ci rewrites .package-lock.json itself, but touch covers the case where the
# install changed nothing and the snapshot kept its old timestamp
$(NPM_STAMP): $(ROOT)/web/package-lock.json
	@command -v npm >/dev/null || { echo "npm not found: Node.js is required"; exit 1; }
	cd $(ROOT)/web && npm ci
	@touch $(NPM_STAMP)

deps-web: $(NPM_STAMP) ## Install frontend dependencies if they are behind package-lock.json

build: $(NPM_STAMP) ## Build the frontend into web/dist
	cd $(ROOT)/web && npm run build

# ---------- distributable package ----------
#
# A wheel with the SPA bundled in (hatch_build.py puts web/dist inside as orc/_web): it is
# installed with a single `uv tool install`, no clone, Node.js or Makefile needed. It must be
# `uv build --wheel`: a bare `uv build` builds the wheel from the sdist, and the sdist lacks
# the git-ignored web/dist.
PKG_DIR := $(ROOT)/dist

package: build ## Build a distributable wheel (into dist/, with install instructions)
	@set -e; \
	if [ -z "$(UV)" ]; then echo "uv not found: install uv (see Requirements in README.md) or set UV=<path>"; exit 1; fi; \
	rm -rf $(PKG_DIR); \
	cd $(ROOT) && $(UV) build --wheel --out-dir $(PKG_DIR) --quiet; \
	cp $(ROOT)/docs/install.md $(PKG_DIR)/INSTALL.md; \
	echo "done: $$(ls $(PKG_DIR)/*.whl)"; \
	echo "hand over the files from $(PKG_DIR)/: installation is described in INSTALL.md"

# ---------- server ----------

$(RUN_DIR):
	@mkdir -p $(RUN_DIR)

start: | $(RUN_DIR) ## Start the server in the background (log in .run/orc.log)
	@set -e; \
	if $(ALIVE); then \
		echo "already running: pid $$(cat $(PID_FILE))  →  http://$(HOST):$(PORT)"; \
		exit 0; \
	fi; \
	if [ -z "$(UV)" ]; then echo "uv not found: install uv (see Requirements in README.md) or set UV=<path>"; exit 1; fi; \
	if [ ! -d "$(ROOT)/web/dist" ]; then \
		echo "no web/dist: run 'make build' first, otherwise the server serves an empty page"; exit 1; \
	fi; \
	cd $(ROOT) && $(UV) sync --quiet; \
	if [ ! -x "$(BIN)" ]; then echo "environment was not built: missing $(BIN)"; exit 1; fi; \
	nohup $(BIN) serve --host $(HOST) --port $(PORT) --log-file $(LOG_FILE) >> $(STDOUT_FILE) 2>&1 & \
	echo $$! > $(PID_FILE); \
	sleep 2; \
	if $(ALIVE); then \
		echo "started: pid $$(cat $(PID_FILE))  →  http://$(HOST):$(PORT)"; \
	else \
		echo "failed to start, last log lines:"; tail -20 $(STDOUT_FILE); rm -f $(PID_FILE); exit 1; \
	fi

stop: ## Stop the server
	@set -e; \
	if [ ! -f $(PID_FILE) ]; then echo "not running (no pid file)"; exit 0; fi; \
	pid=$$(cat $(PID_FILE)); \
	if kill -0 $$pid 2>/dev/null; then \
		kill $$pid; \
		for i in $$(seq 1 20); do kill -0 $$pid 2>/dev/null || break; sleep 0.25; done; \
		if kill -0 $$pid 2>/dev/null; then echo "did not exit on TERM, sending KILL"; kill -9 $$pid; sleep 1; fi; \
		echo "stopped: pid $$pid"; \
	else \
		echo "process $$pid is already gone, removing the pid file"; \
	fi; \
	rm -f $(PID_FILE)

restart: ## Restart the server (stop, then start)
	@$(MAKE) --no-print-directory stop
	@$(MAKE) --no-print-directory start

status: ## Check whether the server is alive and the API responds
	@if $(ALIVE); then \
		echo "process: alive (pid $$(cat $(PID_FILE)))"; \
	else \
		echo "process: not running"; \
	fi
	@printf 'API:     '; \
	curl -sf --max-time 3 http://$(HOST):$(PORT)/api/dispatcher || echo "not responding at http://$(HOST):$(PORT)"
	@echo

logs: ## Follow the server log (Ctrl-C to exit)
	@touch $(LOG_FILE) && tail -f $(LOG_FILE)

dev: ## Run the server in the foreground and open the browser
	@if [ -z "$(UV)" ]; then echo "uv not found: install uv (see Requirements in README.md) or set UV=<path>"; exit 1; fi
	cd $(ROOT) && $(UV) run orc serve --host $(HOST) --port $(PORT) --open

# ---------- tests ----------

test: test-py test-web ## Run all tests

test-py: ## Backend tests
	@if [ -z "$(UV)" ]; then echo "uv not found: install uv (see Requirements in README.md) or set UV=<path>"; exit 1; fi
	cd $(ROOT) && $(UV) run pytest -q

test-web: $(NPM_STAMP) ## Frontend tests
	cd $(ROOT)/web && npm test

# ---------- autostart at macOS login (launchd) ----------
#
# macOS only: install-agent, uninstall-agent and agent-status use launchctl/plutil.

install-agent: | $(RUN_DIR) ## Install a LaunchAgent: the server starts at login (macOS only)
	@set -e; \
	if [ -z "$(UV)" ]; then echo "uv not found: install uv (see Requirements in README.md) or set UV=<path>"; exit 1; fi; \
	if [ ! -d "$(ROOT)/web/dist" ]; then echo "no web/dist: run 'make build' first"; exit 1; fi; \
	cd $(ROOT) && $(UV) sync --quiet; \
	if [ ! -x "$(BIN)" ]; then echo "environment was not built: missing $(BIN)"; exit 1; fi; \
	$(MAKE) -s stop; \
	mkdir -p $(HOME)/Library/LaunchAgents; \
	printf '%s\n' \
	  '<?xml version="1.0" encoding="UTF-8"?>' \
	  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
	  '<plist version="1.0">' \
	  '<dict>' \
	  '  <key>Label</key><string>$(LABEL)</string>' \
	  '  <key>ProgramArguments</key>' \
	  '  <array>' \
	  '    <string>$(BIN)</string>' \
	  '    <string>serve</string>' \
	  '    <string>--host</string><string>$(HOST)</string>' \
	  '    <string>--port</string><string>$(PORT)</string>' \
	  '    <string>--log-file</string><string>$(LOG_FILE)</string>' \
	  '  </array>' \
	  '  <key>WorkingDirectory</key><string>$(ROOT)</string>' \
	  '  <key>EnvironmentVariables</key>' \
	  '  <dict>' \
	  '    <key>PATH</key><string>$(HOME)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>' \
	  '  </dict>' \
	  '  <key>RunAtLoad</key><true/>' \
	  '  <key>KeepAlive</key><true/>' \
	  '  <key>StandardOutPath</key><string>$(RUN_DIR)/agent.log</string>' \
	  '  <key>StandardErrorPath</key><string>$(RUN_DIR)/agent.log</string>' \
	  '</dict>' \
	  '</plist>' > $(PLIST); \
	plutil -lint $(PLIST) >/dev/null || { echo "invalid plist: $(PLIST)"; exit 1; }; \
	launchctl bootout gui/$$(id -u)/$(LABEL) 2>/dev/null || true; \
	launchctl bootstrap gui/$$(id -u) $(PLIST); \
	sleep 3; \
	echo "agent installed: $(PLIST)"; \
	echo "the server starts at every login → http://$(HOST):$(PORT)"; \
	echo "agent log: $(RUN_DIR)/agent.log"

uninstall-agent: ## Remove the LaunchAgent and stop the server (macOS only)
	@launchctl bootout gui/$$(id -u)/$(LABEL) 2>/dev/null || true
	@rm -f $(PLIST)
	@echo "agent removed, autostart disabled"

agent-status: ## LaunchAgent state (macOS only)
	@if [ -f $(PLIST) ]; then echo "plist:  $(PLIST)"; else echo "plist:  not installed"; fi
	@launchctl print gui/$$(id -u)/$(LABEL) 2>/dev/null \
		| grep -E '^[[:space:]]+(state|pid|last exit code) ' \
		|| echo "agent not loaded"

# ---------- docker (alternative to the native start/stop/restart above) ----------
#
# One container: backend + built frontend static files in a single process (see Dockerfile),
# the port is published via network_mode: host (see docker-compose.yml for why not -p).
# Names carry the docker- prefix rather than bare up/down/restart: bare start/stop/restart
# are already taken by the native process above and tied to install-agent/launchd, so
# redefining them would silently break every place in the docs/README that uses them.
# UID is a readonly shell variable, not an environment variable, so make does not see it
# by default: it has to be computed and exported explicitly, otherwise docker-compose.yml
# gets an empty value and fails on "${UID:-1000}".
export UID := $(shell id -u)
export GID := $(shell id -g)

docker-up: ## Build the image and start the container (backend + frontend) in the background
	docker compose up -d --build

docker-down: ## Stop and remove the container
	docker compose down

docker-restart: ## Stop the container, then rebuild the image (cache may be reused) and start it
	docker compose down
	docker compose up -d --build
