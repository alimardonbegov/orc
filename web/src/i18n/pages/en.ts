/**
 * Texts of the "About" and "How it works" pages as a separate dictionary: there are many of them,
 * and in the shared file they would drown out the interface labels. It joins the main dictionary
 * under the `pages` key, so the typing is the same: a missing key in another language is
 * a compile error.
 *
 * `code` in backticks is allowed in strings — RichText renders it in monospace.
 */
export const pagesEn = {
  nav: {
    about: "About orc",
    guide: "How it works",
    helpNav: "About and help",
    backToBoard: "Back to board",
  },
  demo: {
    play: "Play",
    pause: "Pause",
    replay: "Replay",
    goToStep: "Step {step}",
    stepOf: "{step} / {total}",
    regionLabel: "Animated demo: {title}",
  },
  about: {
    eyebrow: "Task orchestrator for Claude Code",
    title: "A kanban board that does its own tasks",
    lead: "Drop a card into «To do» and stop clicking. Every 30 seconds the dispatcher takes tasks from the queue, gives each one its own git worktree, runs `claude --bg` there, checks the result with your verify command and, if it's green, merges the branch itself — `--no-ff`, one at a time, no pull request. Fill the queue in the evening, read the diff in the morning.",
    ctaGuide: "How it works",
    ctaAddProject: "Add a project",
    flowHeading: "Three steps, then it runs on its own",
    flow: {
      queue: {
        title: "You queue",
        body: "A card with a clear assignment for the agent goes into «To do». Priority, model, base branch and dependencies are set right on the card.",
      },
      work: {
        title: "The agent works",
        body: "Each task gets its own worktree and branch `orc/task-<id>`. Several agents work in parallel without stepping on each other.",
      },
      ship: {
        title: "orc checks and merges",
        body: "Your `verify_cmd` decides, not the agent's word. Green — merge into the base branch; red — the task goes back with an explanation.",
      },
    },
    featuresHeading: "What orc does that others don't",
    featuresLead: "Separately, almost every feature exists somewhere. The whole bundle — board, auto-dispatcher, hard verify gate, auto-merge without a PR, conflicts returned to their author and quota accounting — nobody else puts together.",
    features: {
      dispatcher: {
        title: "Pull-based dispatcher",
        body: "No «start» button: the dispatcher picks up tasks itself and respects per-project and global agent limits.",
      },
      verify: {
        title: "Verify gate before merge",
        body: "Your command — tests, linter, build — runs in the task's worktree. Nothing is merged past a red check.",
      },
      merge: {
        title: "Auto-merge without a PR",
        body: "`--no-ff` into the task's base branch, strictly one at a time. If you're editing that branch by hand, orc first saves your edits as a separate wip commit.",
      },
      conflict: {
        title: "Conflicts go back to their author",
        body: "A semantic merge conflict goes to the session that wrote the code — it knows why it was done that way. Three attempts, then a human.",
      },
      quota: {
        title: "Quota is a resource",
        body: "Claude subscription limits are always on screen, and when they run out, tasks wait for the reset instead of failing.",
      },
      live: {
        title: "Replies reach a live session",
        body: "The agent asked something — the card floats up with a badge, and your reply lands in the same session within seconds, without a restart.",
      },
      cost: {
        title: "The cost of every task",
        body: "Tokens across all sessions and subagents of a task, straight from Claude Code transcripts, broken down by model.",
      },
      summary: {
        title: "A summary for the long run",
        body: "Throughput, success rate, time per task, friction and the most expensive tasks — next to the board, one key away.",
      },
    },
    forHeading: "Who it's for",
    forItems: {
      solo: "One developer without a reviewer: where teams open pull requests for each other, here `verify_cmd` decides.",
      subscription: "Runs through the Claude Code CLI on your machine — on the subscription you already pay for, with no separate credit pool.",
      local: "Everything stays local: the server listens only on 127.0.0.1, and the data lives in SQLite next to it.",
    },
    notHeading: "What orc deliberately is not",
    notLead: "These belong to teams that have been building them for years. orc doesn't compete there — it takes what nobody else has taken.",
    notItems: {
      multiAgent: {
        title: "Not multi-agent",
        body: "Only Claude Code. No Codex, Cursor or OpenCode.",
      },
      diff: {
        title: "No diff review in the UI",
        body: "The result is a merged commit — read the diff in your editor or in git.",
      },
      cloud: {
        title: "No cloud or team mode",
        body: "One machine, one person, localhost.",
      },
    },
    limitsHeading: "Current limitations",
    limitsLead: "Worth knowing before you give orc a real repository.",
    limits: {
      local: {
        title: "Claude Code only, this machine only",
        body: "The API answers only on loopback; other devices can't reach it. Autostart at login exists only for macOS (LaunchAgent) — on Linux start the server yourself or use Docker.",
      },
      planMode: {
        title: "No «plan» permission mode",
        body: "A session waiting for plan approval looks «working» to the dispatcher and would hang silently, so the mode isn't offered yet.",
      },
      quotaRegex: {
        title: "Quota detection is a hypothesis",
        body: "The patterns that recognize an exhausted limit are a guess and can be tuned in settings. After 5 quota retries in a row the task fails with an explanation.",
      },
      delivery: {
        title: "Messages arrive at the next tool call",
        body: "A note to a running session goes through a hook — usually within seconds, but a session that thinks for a long time picks it up later. Then you can interrupt it.",
      },
      rework: {
        title: "Rework needs a live worktree",
        body: "«Rework» continues the same session in the same working copy. Once the worktree is removed, only a new task is left.",
      },
      images: {
        title: "Images travel as file paths",
        body: "`claude --bg` takes a single text argument, so the agent gets the image's path and opens it with Read. png, jpeg, gif and webp up to 10 MB.",
      },
      autocommit: {
        title: "Your uncommitted edits get committed",
        body: "Before merging into a branch you're working in, orc commits tracked changes as `wip(orc): auto-commit before merge #id`. Push stays off until you turn it on.",
      },
      stop: {
        title: "No gentle «Stop» yet",
        body: "A running task can only be closed manually or deleted. Pausing it and returning it to the backlog with the work kept is still a plan.",
      },
    },
    risksHeading: "Accepted risks",
    risksLead: "Not unfinished work but deliberate decisions — closing them would mean giving up what orc exists for.",
    risks: {
      noHuman: {
        title: "No human between the agent and origin",
        body: "Merge, and push if it's on, follow the report the agent writes itself. `verify_cmd` is the only independent voice.",
      },
      verifyEdited: {
        title: "verify_cmd runs code the agent just edited",
        body: "If the check calls `make test` or `npm test`, the agent could have changed that script in the same task. Running orc on someone else's repository is like running their Makefile.",
      },
      localRead: {
        title: "Any local process can read the API",
        body: "Changes require the console token, reads don't: task list, descriptions and repository paths are visible to any program running as your user.",
      },
    },
    roadmapHeading: "What's next",
    roadmapLead: "Ideas with research or a plan behind them. No dates — the order depends on what hurts most in daily use.",
    roadmapStatus: {
      plan: "plan written",
      research: "researched",
      idea: "idea",
    },
    roadmap: {
      stop: {
        title: "«Stop» button",
        body: "Stop a running task and return it to the backlog with its work kept — then continue from the same place or start over.",
      },
      planMode: {
        title: "Plan mode",
        body: "Read the session's «approve plan» signal and show it as an ordinary «waiting for reply» card.",
      },
      ide: {
        title: "Open in the editor",
        body: "Links from a card to its worktree in VS Code and to the live Claude session; later, a «human at the wheel» mode.",
      },
      windows: {
        title: "Time windows",
        body: "Let the dispatcher work only at set hours — for example, overnight while the quota is idle.",
      },
      review: {
        title: "Review before merge",
        body: "An optional flag: after a green check the task waits for your OK instead of merging right away.",
      },
      sessionLog: {
        title: "Session log in the card",
        body: "See what the agent is doing right now without opening a terminal.",
      },
    },
    footer: "orc is pronounced «ork». The full story is in README.md and docs/ in the repository.",
    brandBook: "Brand book",
  },
  guide: {
    title: "How it works",
    lead: "Step by step, from an empty board to a merged task. Each section says where things live in the interface and what to set up there.",
    tocLabel: "Contents",
    where: "Where",
    tip: "Tip",
    sections: {
      start: {
        title: "Before you start",
        where: "Terminal, in the orc folder",
        intro: "orc runs on your machine and drives the Claude Code CLI. Here's what it needs:",
        steps: {
          s1: "macOS or Linux, Python 3.12+, Node.js with npm, and `uv`.",
          s2: "Claude Code CLI in PATH, logged in to your subscription: `claude --bg` must work in a terminal.",
          s3: "A git repository for every project — each task works in its own `git worktree`.",
          s4: "One-time setup: `make setup`, then `make start` — the console opens at http://127.0.0.1:8765.",
          s5: "Optional: `make install-agent` starts the server at every macOS login, and `make docker-up` runs it in Docker instead.",
        },
        tip: "`make status` tells you whether the server is alive, and `make logs` shows its log.",
      },
      project: {
        title: "Add a project",
        where: "Sidebar → «+» next to «Projects»",
        intro: "A project is a git repository plus the rules for working in it. Everything here can be changed later in project settings — the gear in the board header.",
        steps: {
          s1: "Name and repository path. A folder without git? orc offers to run `git init` with an empty first commit on main.",
          s2: "«Agents at once» — how many tasks of this project run in parallel. orc settings also have a global cap.",
          s3: "«How to run agents» — default model, effort and permission mode for new tasks. Each task can override them.",
          s4: "«Base branch» — where task branches start from and where results merge back. Empty means the branch currently checked out in the repository.",
          s5: "«Pre-merge check» — the verify command (for example, `make test`) and its timeout. This is the main safety gate: without it, the merge trusts only the agent's word.",
          s6: "«After merge» — push to origin. Off by default: orc never pushes on its own until you enable it.",
          s7: "«Project memory» — edit CLAUDE.md right here: permanent instructions that every agent of this project reads.",
          s8: "Press «Save». Settings are saved only by the button, and the dialog won't close on an outside click while there are unsaved changes.",
        },
        tip: "Moved the repository folder? Change the path in project settings — orc relinks the tasks' working copies with `git worktree repair`.",
      },
      task: {
        title: "Create a task",
        where: "«Task» button in the board header, or the N key",
        intro: "The card's title is for you; the agent receives the «Task for the agent» field. Write it the way you'd brief a colleague who doesn't know the context.",
        steps: {
          s1: "Title — a short name for the board.",
          s2: "«Task for the agent» — what to do, where it lives and how to check it. Paste screenshots right where they belong: Ctrl+V, drag-and-drop or the «Image» button. «Text / Preview» shows what the agent will see.",
          s3: "«Run parameters» — model, effort and permission mode. An empty field takes the project's value and follows it if the project changes.",
          s4: "Permission modes: `auto` — Claude decides itself; `acceptEdits` — edits files without asking; `dontAsk` — never asks, and anything not pre-approved just doesn't run; `bypassPermissions` — no checks at all, only for your own repositories.",
          s5: "Priority, base branch and «Blocked on tasks»: a dependent task waits until the tasks it depends on are done, even in other projects.",
          s6: "Leave the card in «Backlog» as a note, or put it in «To do» — the dispatcher picks it up on the next tick. A card with an empty assignment can't go to «To do».",
        },
        tip: "The base branch can be changed while the card is in «Backlog» or «To do». Once the task starts, the working copy already exists and it's too late.",
      },
      dispatcher: {
        title: "What the dispatcher does",
        where: "Bottom of the sidebar — the dispatcher panel",
        intro: "There's one dispatcher for all projects. Every `poll_interval_sec` seconds (30 by default) it makes a pass — a tick:",
        steps: {
          s1: "Takes tasks from «To do» while there are free slots and creates a worktree with branch `orc/task-<id>` from the task's base branch.",
          s2: "Runs `claude --bg` there with your assignment, model and permission mode. The card moves to «In progress».",
          s3: "When the session finishes, reads `.orchestrator/report.json`. If the agent reports a failure, the task comes back with its explanation.",
          s4: "Runs `verify_cmd` in the worktree — the «verifying» badge. Red: the task goes back to the agent with the check's output.",
          s5: "Green: the task joins the merge queue — the «merging» badge: `--no-ff` into the base branch, one task at a time. Then «Done».",
          s6: "The dispatcher panel shows the heartbeat and busy agents. «Pause» stops dispatching new tasks; «Run now» makes a pass without waiting for the timer.",
        },
        tip: "The orc's eyes in the logo glow while the dispatcher is alive and pulse while agents are working.",
      },
      input: {
        title: "When the agent needs you",
        where: "«Waiting for me» bar above the board",
        intro: "Magenta is the only color in the interface that calls a human. A card that needs you floats to the top of its column and gets a badge.",
        steps: {
          s1: "The agent asked for permission, asked a question or proposed a plan — the card gets «waiting for reply», and the counter in the header grows.",
          s2: "Open the card: the agent's question is at the top. Answer in «Reply to Claude» — screenshots work here too.",
          s3: "The reply goes to the same session within seconds, and it continues where it stopped.",
          s4: "You can write to a working session without being asked: the «To session» button next to the note field. The text arrives at its next tool call without interrupting it.",
          s5: "If the session doesn't pick up the message for a few minutes, the card says so and offers «Interrupt session» — then the text is delivered with a restart.",
        },
        tip: "Questions from other projects appear as a separate chip in the same bar — the dispatcher is shared, so nothing gets lost.",
      },
      problems: {
        title: "Conflicts, failures and quota",
        where: "Badges on the card and in its window",
        intro: "Most problems resolve without you. Here's what orc does on its own and when it calls you.",
        steps: {
          s1: "Merge conflict: the task that arrives second finds someone else's edits in its files. orc sends the conflict back to the session that wrote the code; it resolves it by meaning, passes the check again and returns to the merge queue. After three attempts — the «conflict» badge.",
          s2: "A failed task is red, and the reason is in the card. «Retry» starts from scratch; «Resume session» continues the same session.",
          s3: "Quota: when the Claude limit runs out, the task waits with the «quota» badge, and the dispatcher resumes it after the reset.",
          s4: "«not trusted»: Claude Code won't start sessions in a folder you haven't trusted. «Trust folder and start» fixes it once per project.",
          s5: "«dirty copy»: the target branch has an unfinished merge, rebase or cherry-pick. orc won't touch it — finish the operation, and the task continues.",
        },
        tip: "The orc setting «Merge conflicts are resolved by the session itself» — turn it off if you want every conflict to come to you.",
      },
      finish: {
        title: "Finishing and cleaning up",
        where: "Task window",
        intro: "A finished task can be continued, and a stuck one can be closed by hand.",
        steps: {
          s1: "«Rework» on a done card: write what to fix — the card returns to «To do», continues the same session in the same worktree and is merged a second time.",
          s2: "«Close manually» is an emergency exit for a stuck card: the session stops, the card goes to «Done» bypassing check and merge, and the branch stays unmerged. Dragging the card to «Done» does the same.",
          s3: "«Archive» is reversible: the card disappears from the board and from the dispatcher's view. The «Archive» filter in the header shows archived tasks, and «Restore from archive» brings one back.",
          s4: "«Delete» is permanent: the task, its conversation and — unless you untick it — its branch and worktree.",
          s5: "«Done» has its own sort menu: newest first, oldest first or failures first.",
          s6: "A finished task stays at the top of «Done» as not viewed until you open its card or tick the mark in its corner. Untick it and the task goes back to the top. Not-viewed counters sit on the «Done» button and in the project list; turn this off in project settings.",
        },
        tip: "orc can remove worktrees of merged tasks by itself — see «Clean up worktrees of merged tasks» in orc settings. While the worktree exists, «Rework» works.",
      },
      branches: {
        title: "Branches and worktrees",
        where: "Board header — the branch and folder buttons next to the project gear",
        intro: "Branches and working copies live in git, not in orc's database, so these windows read them directly.",
        steps: {
          s1: "«Project branches» shows every branch and who holds it: open in the repository, base for new tasks, not merged, tasks working in it.",
          s2: "Create, rename and delete branches here. Renaming moves every card that referenced the branch; deleting moves waiting tasks to the project's base branch.",
          s3: "Dangerous operations are explained, not hidden: a lock with the reason when it would break running work, and a confirmation listing the losses when it's your call.",
          s4: "«Worktrees» lists every working copy of the project with its task, state and size, and lets you remove the ones you no longer need.",
        },
        tip: "A branch deleted outside orc doesn't silently disappear: the list marks it «this branch no longer exists».",
      },
      overview: {
        title: "Summary, limits and events",
        where: "«Board / Summary» toggle and the bottom of the sidebar",
        intro: "The board answers «do I need to step in right now». Everything else answers longer questions.",
        steps: {
          s1: "«Summary» (the D key): tiles, throughput over time, task duration, breakdowns by model, effort, permission mode and project, friction and the most expensive tasks. Scope — the current project or all; period — 7, 30 or 90 days or all time.",
          s2: "Claude limits at the bottom of the sidebar: the 5-hour and weekly windows of your ACCOUNT, with reset time. The refresh button asks Claude right now — it takes a few seconds.",
          s3: "The coin badge on a card is the task's token total across all sessions and subagents. The task window breaks it down by model and by agent.",
          s4: "Events (the E key): runs, agent questions, check results; new ones are marked. «All events and filters» opens the full feed with filters by project and level.",
        },
        tip: "Money in the summary measures usage at API prices — on a subscription these dollars aren't charged.",
      },
      settings: {
        title: "orc settings",
        where: "Sidebar → «Settings»",
        intro: "Shared by all projects. Things specific to one project live in its own settings.",
        steps: {
          s1: "Appearance and language: theme — system, light or dark — and one of six interface languages.",
          s2: "«Agents at once» — the global cap across projects; «Dispatcher tick, seconds» — how often orc looks for work; «Checks at once» — parallel verify commands.",
          s3: "«Models in dropdowns» — hide models you never use; a project can keep its own list.",
          s4: "«Task prompt template» and «Conflict-resolution prompt» — the text agents receive; orc fills in the placeholders.",
          s5: "«Quota-exhausted patterns» — a JSON list of regular expressions; a match sends the task to wait instead of failing.",
          s6: "Housekeeping: how many days to keep events, the total size of attachments, and automatic cleanup of merged tasks' worktrees.",
        },
        tip: "Settings are validated on save: a broken regular expression or template won't be accepted.",
      },
      hotkeys: {
        title: "Hotkeys",
        where: "Anywhere on the board",
        intro: "They work when the focus isn't in a text field and no window is open.",
        keys: {
          n: "New task",
          slash: "Search tasks",
          e: "Events feed",
          d: "Board / Summary",
          bracket: "Collapse the sidebar",
          question: "This guide",
          esc: "Close a window",
        },
      },
    },
  },
  demos: {
    board: {
      title: "A task's path across the board",
      card: "Add a dark theme",
      captions: {
        c1: "The card waits in the backlog — a note for later.",
        c2: "You drag it to «To do». That's the whole launch.",
        c3: "The dispatcher picks it up: worktree, branch, `claude --bg`.",
        c4: "The agent is done — `verify_cmd` checks the result.",
        c5: "Green check — merge `--no-ff` into the base branch.",
        c6: "Done. The card shows what the task cost in tokens.",
      },
    },
    pipeline: {
      title: "One dispatcher tick",
      queue: "To do",
      captions: {
        c1: "There's a free slot — the task is taken from the queue.",
        c2: "A separate worktree and branch are created for it.",
        c3: "`claude --bg` starts with your assignment.",
        c4: "The session finishes and writes its report.",
        c5: "`verify_cmd` runs in the task's worktree.",
        c6: "Merge into the base branch, one task at a time.",
      },
    },
    input: {
      title: "The agent asks — you answer",
      card: "Migrate the database",
      otherCard: "Update dependencies",
      question: "Drop the old users_v1 table or keep it?",
      reply: "Keep it for now and add a TODO",
      captions: {
        c1: "The agent is working.",
        c2: "It has a question: the card turns magenta and floats up.",
        c3: "You open the card and see the question.",
        c4: "You reply in «Reply to Claude».",
        c5: "The reply reaches the same session, and the work goes on.",
      },
    },
    conflict: {
      title: "A conflict goes back to its author",
      taskA: "Header redesign",
      taskB: "Compact board",
      captions: {
        c1: "Two tasks finished in parallel; both target `dev`.",
        c2: "#41 merges first.",
        c3: "#42 finds #41's edits in the same files — a conflict.",
        c4: "orc hands the conflict back to #42's session: `dev` is merged into its branch.",
        c5: "The session resolves it by meaning and passes the check again.",
        c6: "#42 merges. You didn't have to do anything.",
      },
    },
    project: {
      title: "Adding a project",
      projectName: "my-app",
      captions: {
        c1: "Click «+» next to «Projects».",
        c2: "Enter a name and the repository path.",
        c3: "The verify command is the gate before merge.",
        c4: "How many agents can work at once.",
        c5: "Save — the project appears in the sidebar.",
      },
    },
  },
};

// Without as const — for the same reason as the main dictionary (see en.ts).
export type PagesDictionary = typeof pagesEn;
