# Waiting for input: how a task session asks a human

Verified on Claude Code 2.1.278 with live spikes on 2026-09-21. This is the decision document for
the problem where tasks waiting for input (a Bash permission request) were shown on the board as
"in progress" with no hint at all that they were waiting.

## What was wrong

The dispatcher assumed that waiting arrives as `state: "blocked"` in `state.json`. In reality the
daemon writes `blocked` only when the agent **has finished its turn with a text question**. The
three real interactive dialogs — a tool permission, `AskUserQuestion`, plan approval — leave
`state: "working"`, and the waiting goes into other fields:

| Dialog | `state` | `tempo` | `needs` |
|---|---|---|---|
| tool permission | `working` | `blocked` | `approve Bash: echo hello > HELLO.txt` |
| AskUserQuestion | `working` | `blocked` | `answer: Which color to pick? (red · blue)` |
| plan approval (plan mode) | `working` | `blocked` | `approve plan` |
| text question at the end of a turn | `blocked` | `active` | — (text in `detail`) |

`_apply_state` looked only at `state`, and the `working` branch even cleared the badge. The card
stayed "in progress" forever, the worker slot was occupied, and the "waiting for me" strip was
empty.

## Why you cannot just answer with text

The only way to push text into a waiting session is `claude stop` + `claude --bg --resume` (see
[message-delivery.md](message-delivery.md)). For a tool permission that does not work: the stop
interrupts the call, and after the resume the agent reads "allowed", calls the same tool — and runs
into the dialog again. Flags on resume (`--allowedTools`, `--permission-mode`) do not help: the
daemon answers "keeps its own saved options, so the flags you passed started a copy" and creates a
copy of the session.

For `AskUserQuestion`, a resume with text is not an answer to the question either: the tool is
interrupted, the agent receives `[Request interrupted]` and, as the spike showed, asks again in
text ("write COLOR.txt or cancel?").

## Solution: two channels

### Primary — Claude Code hooks

The session has hooks, and two of them can close exactly these dialogs without a terminal:

- `PermissionRequest` — called instead of the permission dialog; the reply is
  `{"decision": {"behavior": "allow" | "deny", ...}}`.
- `PreToolUse` for `AskUserQuestion` and `ExitPlanMode` — `permissionDecision: "allow"` together
  with `updatedInput` closes the dialog: for a question, the original `questions` plus `answers`
  `{question text: answer}` go into `updatedInput`; for a plan, `deny` with a
  `permissionDecisionReason` sends the agent back to refine the plan.

The script `orc/hooks/input_hook.py` (stdlib only) receives the event on stdin, registers the
request in orc (`POST /api/hooks/input-requests`) and polls it every two seconds until the owner
answers. All that time the tool "hangs" inside the session — the session is alive, nothing is
stopped or resumed, no copies appear. The ceiling for the wait is the hook's `timeout`, one day.

The hook gets `--secret-file` with the path to `<data>/hook-secrets/task-<id>` and sends its
contents in the `X-Orc-Hook` header; both `/api/hooks/*` endpoints compare it with the secret of
the task named in the request. A task without a secret (`hook_secret` is NULL: not yet issued or
reset) is rejected with 403 — the permission channel is open only to a session that was issued a
secret. If the task id is unknown, the check returns silently and the endpoint itself answers
404/409, so the hook yields to the Claude Code dialog.

The dispatcher (`Dispatcher.request_input`) immediately sets `blocker=needs_input` with a short
summary and writes an event; the decision (`Dispatcher.answer_input`) is validated against the
request kind (`orc/inputs.py`), stored in `input_requests.decision`, appears in the card's
conversation in words ("Allowed: Bash — …", "Which color? → blue", "Plan not approved: …") and
clears the badge. The hook picks up the decision and prints the reply in the Claude Code format.

Spike facts (static hooks without orc first, then a full run through orc and the dashboard):

- `PermissionRequest` + `allow` — Bash ran; Claude Code accepts a hook reply delayed by 5 and 25
  seconds just like an instant one — there is no window for answering, only the hook's `timeout`.
- `PreToolUse` + `answers: {"Which color to pick?": "blue"}` with a 20-second delay — the agent
  wrote "blue" into COLOR.txt.
- Through orc: the request is visible on the card about 3 seconds after the session reaches the
  dialog; the "Allow" button and choosing an option on the card took the session to the end with no
  stops.
- **Trap:** inside `~/.claude/…` (for example in `~/.claude/jobs/<id>/tmp`) Claude Code adds a
  second "sensitive file" dialog to Bash commands that write files, which the hook does not see —
  such sessions stand until answered by hand. Spikes and e2e runs must be done in an ordinary
  folder.
- **Resume loses hooks.** A session that has reached done/failed is still "running" as far as the
  daemon is concerned, and `claude --bg --resume` creates a copy **without the saved options** —
  the hooks do not make it into the copy. That is why `ClaudeCli.resume_bg` accepts `settings`, and
  the dispatcher passes the hooks again on any resume except waking a stopped (`stopped`) session:
  the daemon wakes it with its saved options, and flags would turn the wake-up into a copy.

What else the permission decision can do: `scope: "session"` adds `updatedPermissions` with an
`addRules` rule for the whole tool and `destination: "session"` — "do not ask about Bash again until
the end of the session"; nothing is written to the project settings.

### Fallback — `tempo`/`needs` from `state.json`

`JobState.waiting` = end of turn (`blocked`, or `working` + `tempo == "idle"`, see below) **or**
`state == "working"` and (`tempo == "blocked"` or a non-empty `needs`). The dispatcher sets
`needs_input`, translating `needs` into human-readable text (`orc/inputs.describe_needs`). This
catches sessions without hooks (started before hooks were introduced), cases where orc was
unreachable at the moment of the dialog (the hook then exits silently and Claude Code shows its own
dialog), and text questions at the end of a turn.

An answer from the card's composer goes as before — stop + resume. For a text question this is
a full answer; for a permission it is only a way to rephrase the task so that the agent does not
call that tool.

Three caveats:

- the badge from the fallback channel is not set for `INPUT_ANSWER_GRACE_SEC` seconds after an
  answer through the hook: the daemon rewrites `tempo`/`needs` with a delay (more than 30 s in the
  spike), and without the pause the card would say "waiting for permission" again right after the
  permission was granted;
- the "session is alive" branch clears the badge only if there is no open request from a hook —
  while the hook holds the tool, the daemon correctly reports the session as working;
- a `state.json` signal is trusted only for a silent session — see below.

## False waiting: `blocked` from text at the end of a turn

An analysis of a real incident (2026-09-22). The session ran in bypassPermissions, asked nobody
anything — and still got a "waiting for reply" alert for nine minutes, which then cleared by
itself.

What was in `state.json` and the transcript:

```
13:16:53  agent (to a subagent): "The warning fires on every navigation… I ask for one fix
                                  before the repeat review."
13:17:17  daemon: state = blocked          ← alert on the board
13:18:59  the subagent returned its report, the session went on working (transcript growing)
13:26:16  daemon: state = working          ← the alert cleared by itself
```

Conclusion of the spike: **the daemon sets `blocked` from the TEXT at the end of a turn** — this is
a heuristic, and a line to a subagent ("please fix this") is indistinguishable from it as a
question to a human. The session was waiting not for the owner but for a subagent's report, and
would have gone quiet again only at the very end. On top of that, `blocked` is sticky: the daemon
rewrote it only nine minutes later, although the session had been working for a minute and a half.

What was done so that the alert does not lie:

- **`inFlight` from `state.json`.** The daemon writes the counters of the session's background work
  there (`tasks`, `queued`, `drainableMonitors`). `JobState.in_flight` is background work without
  the queue and without passive subscriptions (see the sections on stuck `inFlight` and artifact
  subscriptions below), and while it is non-zero `state == "blocked"` does not count as waiting:
  the session will be woken by the harness, not by a human. This does not apply to
  `tempo`/`needs` — they come from a real dialog.
- **Confirmation by silence.** The fallback-channel badge is set only if the session transcript has
  not grown for `WAITING_QUIET_SEC` (90 seconds — three default ticks). The transcript grows on
  every message and tool call, so it is a more reliable sign of a working session than `state`.
  Subagents write not into it but into `<session>/subagents/agent-*.jsonl` — those files are
  counted too. If there is no transcript (an old session, the file is unavailable), the state is
  trusted as before.
- **Clearing by a live transcript.** The "session is alive" branch now also fires on `blocked`: as
  soon as the transcript grows again, the badge goes away without waiting for the daemon to rewrite
  `state`. The removal is accompanied by an event "waiting cleared, the session continued on its
  own" — an alert that vanished without explanation looked like a malfunction.

The price is that a genuine text wait appears on the board not instantly but within a minute and a
half. For dialogs (permission, question, plan) there is no delay at all: they are brought by the
hook, and it registers the request immediately.

> The sections below tell how this was found, when `report.json` was the signal. It is `orc task done`
> now, compared with the start of the turn in the same way: see [handoff.md](handoff.md).

### Final report instead of a question

The same heuristic also catches the end of the work: the agent handed in the task with a report
containing a list of "what is needed from you" (read the spec, agree with the backend developer),
the daemon wrote `state: blocked`, and in `needs` its own retelling in a single English line:
`coordinate with backend on: ETag/304 caching, …`. The card showed "Agent is waiting for a reply"
with that line, although the session was waiting for nothing, and `done` never came from the daemon.

What was done (`orc/transcript.py`, `Dispatcher._reported_this_turn`):

- **A report in this turn = the work is handed in.** Per the prompt, `report.json` is the last
  action. If, with `state == "blocked"`, the report was written later than the line that opened the
  last turn (the prompt, the owner's reply, a resume — a `type: "user"` row with text in the
  transcript), the task goes to review as it would on `done`. A report from a previous pass is older
  than that line and does not count. It does not fire while an owner's message is on its way into
  the session (`outbox_state`) or a request from a hook is open.
- **The agent's words instead of the daemon's retelling.** If it is a question after all, the
  agent's final text goes into `blocker_detail` (the text blocks after the last tool call, up to
  4000 characters), and the daemon's `needs`/`detail` are used only when there is no transcript.

### A report that stops for the owner: `needs_input`

The opposite mistake. A session built what was asked, published a page with four questions for the
owner, wrote `report.json` with `status: success` as the prompt told it to, and ended its turn. By the
rule above the work was handed in: the card went through verification to the merge queue while the owner
was still reading the questions.

The final text cannot tell these apart: "what I need from you" in a finished report and a real question
look the same, and judging by text is what got the daemon into trouble above. So the agent says it
itself, with `status: needs_input` in the report. `_reported_this_turn` does not count such a report, and
the card gets the usual "waiting for reply" badge with the agent's final text. Ending the turn with a
question and writing no report has the same effect. The rule is in the default prompt template and, since
a project can replace the template, in the system prompt of every task session
(`task_guide.HANDOFF_RULE`).

### Stuck `inFlight`: the card is "in progress" forever

A session handed in its work as a report with a list of six decisions; the daemon wrote
`state: blocked`, `tempo: blocked`, `needs: "decide: …"`, and the terminal said "Need input". On the
board the task was "in progress" for half an hour (and onward without end): no badge, no transition
to review, no event.

What was in `state.json` and the transcript:

```
20:54:34  queue-operation enqueue  "the domain is already bought - example.app"      ← the owner wrote into the session
20:55:44  queue-operation remove   reason: absorbed_mid_turn                          ← the agent picked it up mid-turn
21:00:36  end of turn, report.json written; state = blocked, inFlight = {tasks: 0, queued: 1}
```

The daemon did not subtract the message picked up mid-turn from the queue counter. For orc,
`inFlight > 0` meant "the harness will wake the session" — `JobState.waiting` returned False, and
`_apply_state` went into the "session is alive" branch, which does nothing. The "report in this
turn = work handed in" rule (above) is nested inside the waiting branch and never got to the check.
In other sessions with `absorbed_mid_turn` the turn ended with `done`, and there the daemon zeroed
the counter — it sticks only together with `blocked`.

General conclusion: **`inFlight` is a hint from the daemon, not a contract, and trust in it must be
limited**. What was done:

- **`queued` is separated from background work** (`JobState.queued`; `JobState.in_flight` covers
  only tasks and monitors). The queue does not cancel waiting: a real message is picked up by the
  harness right after the turn, the transcript grows, and the silence check will not confirm the
  waiting.
- **A ceiling on trust in background work.** `blocked` with `in_flight > 0` counts as waiting if the
  session has been silent for longer than `IN_FLIGHT_STALE_SEC` (15 minutes): other counters can
  stick in the same way (`artifact_watch`, which hangs in `tasks` for the life of the session, is no
  longer part of background work at all — see below). If this is a mistake (a long background
  command without a single line in the transcript), the badge is removed on its own as soon as the
  session writes any line.
- **Silence is counted across all the session's files**, including subagent transcripts: otherwise
  a long-running subagent would look like idleness, and the ceiling would fire on a live session.

### Claude Code 2.1.293+: no end of turn in `state` any more

Two tasks handed in their work (a commit, `report.json`, a final text) but were "in progress" on the
board forever; in the `claude` terminal they were also in Working, only the asterisk did not
flicker. In both `state.json` files:

```
state: "working", tempo: "idle", inFlight: {tasks: 0, queued: 0}, output: null, firstTerminalAt: null
```

while the transcript ends with `end_turn` and `system/turn_duration` — the turn is over. Among all
sessions in `~/.claude/jobs`, those with `state: done` are on CLI 2.1.292 and earlier; from 2.1.293
no background session reached `done` (or `blocked`): the daemon writes the end of a turn only into
`tempo`. In the middle of a turn, including during a long command, `tempo` stays `active`
(verified by measurement). Two more tasks on 2.1.293 hung the same way and were closed by hand.

The dispatcher moved a task to review only on `state == "done"`, and treated `working` as a live
session. What was done:

- **`JobState.turn_ended`** — `state == "blocked"` or `working` + `tempo == "idle"`. The end of a
  turn goes through the same logic that `blocked` used to: a report written in this turn → the task
  goes to review (the event "the session ended its turn with a report"); none → the "waiting for
  reply" badge with the agent's words. The same requirements: transcript silence for
  `WAITING_QUIET_SEC`, background work cancels the waiting.
- **Message delivery.** `JobState.waiting` is now true for `working/idle` as well, so a message to
  an idle session goes through stop + resume rather than the inbox: the inbox hook lives on tool
  calls, which a standing session does not make.

### An artifact subscription is not background work

A task handed in its work (a commit, `report.json`, a final text) on CLI 2.1.294 but hung "in
progress", although the fix above was already in place. In `state.json`:

```
state: "working", tempo: "idle", inFlight: {tasks: 1, queued: 0, kinds: ["artifact_watch"], drainableMonitors: 1}
```

The agent had published an artifact, and the harness holds a subscription to its comments for the
rest of the session's life. `in_flight` counted it as background work — moreover twice (`tasks` +
`drainableMonitors` = 2) — and the end of the turn was not recognized as waiting. Only the
`IN_FLIGHT_STALE_SEC` ceiling helped, and four minutes after the turn the harness appended
`system/away_summary` to the transcript and pushed it further back. Before 2.1.293 this went
unnoticed: the daemon set `done` itself, and nobody looked at `inFlight`.

- **Passive kinds do not count** (`claude_cli.PASSIVE_IN_FLIGHT_KINDS`, so far only
  `artifact_watch`): the session is woken only by a human's comment — exactly like a message. One
  is subtracted from `tasks` per `kinds` entry; live work next to a subscription remains work.
- **`drainableMonitors` is not added to `tasks`**: these are monitors among the tasks, not on top of
  them. The larger of the two is taken — if the daemon ever writes a monitor without `tasks`, it is
  work too.
- Delivery is fixed as well: an idle session with a subscription used to count as "working, not
  waiting", and the owner's message went into the inbox, which nobody reads in a standing session.

## Chats

A direct chat (orc/chats.py) has no card, but its session hits the same dialogs. Chat sessions get the
same hook with `--chat <id>` instead of `--task <id>`, and a secret in `<data>/hook-secrets/chat-<id>`
(`chats.hook_secret`, reissued with every set of session settings).

- A request is a `chat_messages` row with role `input_request` and state `open | answered | cancelled`;
  the body is JSON (`kind`, `tool_name`, `tool_input`, `summary`, `decision`, `answered_at`). No new table:
  the request sits in the conversation where the owner is reading.
- Endpoints: `POST/GET /api/hooks/chat-input-requests` for the hook, `POST /api/chats/{id}/input-requests/{mid}/answer`
  for the dashboard. Decisions are validated by the same `inputs.validate_decision`.
- While a request is open the chat is `waiting` with the request summary. A new message from the owner
  stops the session and cancels the request, as for a card. The `needs` fallback of `state.json` stays for
  dialogs the hook did not catch, and is muted for `INPUT_ANSWER_GRACE_SEC` after an answer.

## Request lifecycle

```
hook: POST /api/hooks/input-requests  ──►  input_requests(state=open), blocker=needs_input, event
                                              │
owner: card → form by request kind            │
       POST /tasks/{id}/input-requests/{rid}/answer
                                              ▼
                                       state=answered, decision, comment, blocker=null
                                              │
hook: GET /api/hooks/input-requests/{rid} ◄───┘  → prints the hook reply → the tool proceeds
```

A request is closed without an answer (`cancelled`) when the session goes away: done/failed/stopped,
a resume (any — including after text through the common field), closing by hand, deleting the task.
A new request of the same task closes the previous one: its hook no longer exists.

## What is visible in the dashboard

- **The card and the "waiting for me" strip** — a label by request kind: "waiting for permission",
  "waiting for reply", "waiting for plan approval" (`inputKindLabel` in `web/src/labels.ts`, the
  same dictionary as `KIND_LABEL` in `orc/inputs.py`).
- **The "In progress" column** — waiting cards stand on a separate shelf, "Waiting for input · N",
  above the "Working · M" shelf. There is no shelf when nobody is waiting.
- **The task card** rereads its details when the task's snapshot on the board changes (badge,
  request, status): a question asked by the agent while the window is open appears in it on its own,
  without a reload.
- **The task card** has the `InputRequestPanel` panel at the very top: for a permission — the
  command and the buttons "Allow", "Allow for the rest of the session", "Deny…" (with a reason that
  goes to the agent); for a question — the options as buttons (single or multiple choice), a
  "custom answer" field; for a plan — the plan text, "Approve plan", "Return with notes…". A message
  sent past the request dismisses it with Esc, as it would in a console, see
  [message-delivery.md](message-delivery.md).

## Limits

- A waiting task still occupies a worker slot: it is in `in_progress`, and `max_workers` counts it.
  This is deliberate — the session is alive and holds the worktree.
- `plan` has not been added to the list of modes (see [plan-mode.md](plan-mode.md)): the approval
  channel is ready, but after `allow` the session stays in plan mode and will go planning again —
  a `setMode` in `updatedPermissions` is needed, which is a separate piece of work.
- `ExitPlanMode` through `PreToolUse` was not checked with a spike: the format is taken from the
  hooks documentation.
- If orc restarted while a hook was waiting, nothing is lost: the request is in the database, and
  the hook keeps polling (it tolerates an unreachable server for up to two minutes in a row).
