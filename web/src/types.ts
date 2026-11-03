export type TaskStatus = "backlog" | "todo" | "in_progress" | "verifying" | "merging" | "done" | "failed";
export type Priority = "high" | "normal" | "low";
export type Blocker = "needs_input" | "conflict" | "dirty_copy" | "quota" | "untrusted" | null;
/** Delivery state of a message to the task session: a badge on the card. */
export type OutboxState = "queued" | "sent" | "stopping" | "stalled";

export type PermissionMode = "auto" | "acceptEdits" | "dontAsk" | "bypassPermissions";

export interface Project {
  id: number;
  name: string;
  path: string;
  default_model: string | null;
  default_effort: string | null;
  default_permission_mode: PermissionMode;
  /** Base branch of the project's new tasks. null — use the repository's current branch. */
  default_branch: string | null;
  verify_cmd: string | null;
  verify_timeout_sec: number;
  max_workers: number;
  push_enabled: number;
  /** Moment the project was archived. null — the project is visible and active. */
  archived_at: string | null;
  /** The project folder is in place and is a git repository. Computed by the server on every poll. */
  path_ok: boolean;
  /** Why the folder is unavailable: "folder does not exist", "no .git in the folder". null — all is well. */
  path_error: string | null;
  created_at: string;
  /** Manual order in the sidebar (drag). null — the project was never reordered by hand, sorted by id. */
  position: number | null;
  /** Models hidden from the project's dropdowns. null — no own list, same as in orc settings. */
  hidden_models?: string[] | null;
  /** Viewing results (viewing.ts): finished tasks of the project wait for the owner's glance.
   *  0 — the project does not take part. The field may not come from an old server — then there are no marks. */
  track_viewed?: number;
}

/**
 * What awaits a new project at the given path — the server's answer before the project is created
 * (orc/projects.py, new_path_status).
 *
 * missing / no_git is not a refusal but a fork: a repository can be set up in place,
 * and the dashboard offers a choice. The other statuses cannot be fixed.
 */
export type ProjectPathStatus = "ok" | "missing" | "no_git" | "not_dir" | "invalid" | "occupied";

export interface ProjectPathCheck {
  /** The resolved absolute path — what will end up in the project card. */
  path: string;
  status: ProjectPathStatus;
  /** Whether a repository can be created here (git init) with the person's consent. */
  can_init: boolean;
  /** What is missing, in human terms. null — the path is ready. */
  message: string | null;
}

/** Response to a project path change: the card plus a relocation summary. */
export interface ProjectMoveResult {
  project: Project;
  /** How many task worktrees were re-attached to the new root. */
  relinked: number;
  /** What was not found at the new location: task branches, missing worktrees. Does not block the relocation. */
  warnings: string[];
}

/**
 * One repository branch with everything the orchestrator knows about it.
 *
 * delete_block / rename_block — the reason for the prohibition (the operation would break work in progress),
 * delete_warnings — what will be lost, but the person may decide for themselves.
 */
export interface BranchInfo {
  name: string;
  commit: string;
  committed_at: string;
  subject: string;
  /** The branch checked out in the repository's main worktree. */
  is_current: boolean;
  /** The base of the project's new tasks. */
  is_base: boolean;
  /** Path of the worktree that holds the branch. null — the branch is free. */
  worktree: string | null;
  /** Tasks for which this is the base and the merge target. */
  target_of: number[];
  /** Tasks that live in this branch (orc/task-N). */
  branch_of: number[];
  /** At least one of the linked tasks is currently in progress, being verified or merging. */
  busy: boolean;
  /** All the branch's commits are already in the project's base branch. */
  merged: boolean;
  delete_block: string | null;
  delete_warnings: string[];
  rename_block: string | null;
}

/** Response of /api/git/branches: the project's branches and the context to read them in. */
export interface BranchesView {
  /** The branch checked out in the repository right now. */
  current: string;
  /** Project setting. null — current serves as the base. */
  default_branch: string | null;
  /** The resulting base of new tasks: default_branch or current. */
  base: string;
  branches: string[];
  items: BranchInfo[];
  /** What exactly the last operation did — shown as a popup message. */
  note?: string;
}

/**
 * One worktree in the project's .claude/worktrees (orc/worktrees.py).
 *
 * delete_block — the reason for the prohibition (deletion would interrupt work in progress),
 * delete_warnings — what will be lost, but the person may decide for themselves.
 */
export interface WorktreeInfo {
  /** Folder name: orc-task-N, orc-merge-N or any foreign one. */
  name: string;
  path: string;
  /** task — a task's worktree, merge — a temporary merge worktree, foreign — not the orchestrator's (a Claude Code session, by hand). */
  kind: "task" | "merge" | "foreign";
  branch: string | null;
  head: string | null;
  /** git knows about this worktree. false — just a folder left on disk. */
  registered: boolean;
  /** The folder exists on disk. false — git remembers a worktree that is already gone. */
  exists: boolean;
  locked: boolean;
  task_id: number | null;
  /** null with task_id — the task was already deleted but the worktree remained. */
  task_title: string | null;
  task_status: TaskStatus | null;
  task_archived: boolean;
  task_done_at: string | null;
  /** Disk space in bytes. null — could not be computed. */
  size_bytes: number | null;
  /** All the worktree's work is already in target. null — unknown or nothing to compare. */
  merged: boolean | null;
  target: string | null;
  /** Uncommitted changes (including new files). null — git did not answer. */
  dirty: number | null;
  /** Processes with a working directory inside the worktree. null — no way to find out (no lsof). */
  processes: { pid: number; name: string }[] | null;
  last_activity: string | null;
  /** The worktree is used by the orchestrator itself: a task's work is running or about to continue. */
  busy: boolean;
  /** busy, or someone is sitting in the folder. */
  in_use: boolean;
  /** Can be removed without losing anything: merged, clean, free, the orchestrator's worktree. */
  safe: boolean;
  delete_block: string | null;
  delete_warnings: string[];
}

/** Response of /api/git/worktrees. */
export interface WorktreesView {
  root: string;
  base: string;
  /** false — processes in folders are not visible (no lsof), "in use" is known only from tasks. */
  processes_known: boolean;
  total_bytes: number;
  items: WorktreeInfo[];
  note?: string;
}

/** Where project memory can live: the repository root or the .claude directory. */
export type ClaudeMdLocation = "root" | "claude-dir";

/**
 * One project memory file. sha is a fingerprint of the content read: with it a write
 * will not overwrite an edit made by an agent or in an editor. exists=false — the file does not exist yet,
 * path says where it will appear. error — the file exists but cannot be read (a directory, not text,
 * too large); we show the reason instead of the editor.
 */
export interface ClaudeMdFile {
  location: ClaudeMdLocation;
  rel: string;
  path: string;
  exists: boolean;
  content: string;
  sha: string | null;
  error: string | null;
}

/** Claude Code reads both places at once, so the dashboard shows them together. */
export interface ClaudeMd {
  files: ClaudeMdFile[];
}

export interface Task {
  id: number;
  project_id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  blocker: Blocker;
  blocker_detail: string | null;
  target_branch: string | null;
  model: string | null;
  effort: string | null;
  permission_mode: PermissionMode | null;
  verify_cmd: string | null;
  requires_review: number;
  worktree_path: string | null;
  branch: string | null;
  job_id: string | null;
  session_id: string | null;
  auto_resume_count: number;
  state_miss_count: number;
  quota_retry_count: number;
  conflict_retry_count: number;
  resume_with: string | null;
  outbox_state: OutboxState | null;
  merge_queued_at: string | null;
  retry_after: string | null;
  report_json: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  /** When the task was first picked up — the moment of its first session. null — the agent has not
   *  started on it yet. The field may not come from an old server. */
  started_at?: string | null;
  /** Archive moment: the card is removed from the board but intact. null — a regular task. */
  archived_at: string | null;
  /** Manual order within a column (drag on the board). null — the task was not reordered, sorted by id. */
  position: number | null;
  /** Tokens across all the task's sessions, JSON of the TaskUsage format (see usage.ts). null — not counted yet. */
  usage_json: string | null;
  /** Deferred start: not earlier than this moment (ISO UTC). null — immediately. The field may not come from an old server. */
  start_after?: string | null;
  /** End of the start window: not later. If it did not get a slot before then, the dispatcher returns the task to the backlog. */
  start_before?: string | null;
  /** When the owner viewed the result (viewing.ts). null — not viewed. A mark older than
   *  done_at refers to a previous delivery. The field may not come from an old server. */
  viewed_at?: string | null;
  /** A run of a recurring task (routines.ts): whose card this is and which run number it is.
   *  null — a regular task. The fields may not come from an old server. */
  routine_id?: number | null;
  routine_run?: number | null;
  depends_on: number[];
  /** An open input request from the session: permission, question, plan. null — the agent is waiting for nothing
   *  (or waits via a fallback channel — then only blocker/blocker_detail exist). The field may
   *  not come from an old server. */
  input_request?: InputRequest | null;
}

/** Kind of input request: tool permission, an AskUserQuestion question, plan approval. */
export type InputKind = "permission" | "question" | "plan";

/** One answer option in AskUserQuestion. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** One AskUserQuestion question (Claude asks up to four at a time). */
export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

/**
 * An input request that a session hook registered in orc and now waits for a decision on
 * (see docs/internals/input-requests.md). tool_input — the tool input as is: for Bash it holds
 * command, for AskUserQuestion — questions, for ExitPlanMode — plan.
 */
export interface InputRequest {
  id: number;
  task_id: number;
  kind: InputKind;
  tool_name: string;
  tool_input: Record<string, unknown> | null;
  summary: string;
  state: "open" | "answered" | "cancelled";
  created_at: string;
}

/** The owner's decision on a request — the shape depends on the kind (validated by orc/inputs.py). */
export type InputDecision =
  | { behavior: "allow"; scope?: "once" | "session" }
  | { behavior: "deny"; message?: string }
  | { answers: Record<string, string> };

/** Token counters of a single Anthropic API call, summed. */
export interface TokenCounters {
  input: number;
  cache_creation: number;
  cache_read: number;
  output: number;
}

/** One agent of one session: the main session (agent_id null) or a subagent (Task tool). */
export interface UsageAgent {
  session_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  description: string | null;
  model: string | null;
  tokens: TokenCounters;
  total_tokens: number;
  messages: number;
}

/** Task token aggregate — what lies in Task.usage_json (written by orc/token_usage.py). */
export interface TaskUsage {
  total: TokenCounters;
  /** Sum of the four counters — "total tokens" on the badge. */
  total_tokens: number;
  models: Record<string, TokenCounters & { messages: number }>;
  agents: UsageAgent[];
  sessions: { session_id: string | null; job_id: string | null; total_tokens: number }[];
  /** Cost estimate from Claude Code (cost-state) — exact, but written only when the session ends. */
  cost_usd: number | null;
  /** Cost estimate by our own rates (orc/token_usage.py) — always computed, including on the fly. */
  cost_usd_estimated: number | null;
  scanned_at: string | null;
}

export interface OutboxMessage {
  id: number;
  task_id: number;
  body: string;
  mode: "soft" | "interrupt";
  state: "queued" | "sent" | "stopping" | "delivered" | "failed";
  attempts: number;
  created_at: string;
  delivered_at: string | null;
}

export interface Comment {
  id: number;
  task_id: number;
  author: "user" | "orc" | "claude";
  kind: "comment" | "answer" | "rework" | "report";
  body: string;
  created_at: string;
}

export interface TaskDetail extends Task {
  comments: Comment[];
  outbox: OutboxMessage[];
}

/** An image uploaded to the orchestrator. The task text refers to it with the marker orc-image:<id>. */
export interface Attachment {
  id: number;
  filename: string;
  mime: string;
  size: number;
  rel_path: string;
  created_at: string;
  url: string;
}

export type EventLevel = "info" | "warn" | "error" | "success";

/**
 * Event feed row. The project name and task title come joined from the server
 * (see Repo.list_events): the feed is shared across all projects, and without them from "#12 is waiting for an answer"
 * you cannot tell either where it is or what the task is about.
 *
 * project_name/task_title may be null: dispatcher events have no project,
 * and the task may have been deleted — then task_id is null too.
 */
export interface OrcEvent {
  id: number;
  task_id: number | null;
  project_id: number | null;
  level: EventLevel;
  message: string;
  is_read: number;
  created_at: string;
  project_name: string | null;
  task_title: string | null;
  task_status: TaskStatus | null;
}

export interface DispatcherStatus {
  paused: boolean;
  quota_retry_after: string | null;
  running: number;
  last_tick: string | null;
  /** How long the last pass took, in seconds. null — there have been no passes yet. */
  last_tick_duration_sec: number | null;
  /** Duration of each pass step: step name → seconds. */
  last_tick_steps: Record<string, number>;
  /** How many times a pass step failed since the server started. */
  tick_error_count: number;
  /** Tasks whose verify command is running right now. */
  verifying_now: number[];
  /** Live orc sessions at the daemon per the sweeper's last pass; null — the sweeper has not run yet. */
  sessions_alive: number | null;
  /** How many sessions the sweeper killed since the server started. */
  reaped_total: number;
  load_avg: number | null;
  free_mem_pct: number | null;
  /** Why new tasks are not starting right now (overload); null — they are starting. */
  start_blocked_reason: string | null;
}

/** One Claude Code account limit: the share of the window used and the reset moment (unix seconds). */
export interface UsageLimit {
  used_percentage: number;
  resets_at: number | null;
}

/**
 * Claude Code account limits: the five-hour and weekly windows — NOT the current task's usage.
 * available=false — no source knows anything.
 * stale=true — numbers exist, but the measurement is over 15 minutes old; on such a request the server
 * also goes to ask for fresh ones itself.
 * A window whose reset time has already passed comes as null: the old percentage no longer applies there.
 */
export interface UsageStatus {
  available: boolean;
  stale: boolean;
  /** Where the numbers come from: Claude's own poll, the statusline of an orchestrator session, or a snapshot
   *  from ~/.claude.json (see orc/usage.py). */
  source: "probe" | "statusline" | "claude_json" | null;
  model: string | null;
  five_hour: UsageLimit | null;
  seven_day: UsageLimit | null;
  /** Windows the account does not have at all (a plan without a five-hour limit) — as opposed to null
   *  "don't know yet". May not come from an old server. */
  absent?: UsageWindowKey[];
  updated_at: number | null;
}

export type UsageWindowKey = "five_hour" | "seven_day";

export interface Settings {
  global_max_workers: string;
  poll_interval_sec: string;
  prompt_template: string;
  quota_patterns: string;
  /** "1" — the session of the task itself merges a conflict with the target branch, "0" — call a human right away. */
  conflict_autoresolve: string;
  conflict_prompt_template: string;
  verify_workers: string;
  events_retention_days: string;
  attachments_max_total_mb: string;
  /** "1" — worktrees of merged tasks are removed automatically after worktree_retention_days days. */
  worktree_autoclean: string;
  worktree_retention_days: string;
  /** JSON list of model ids hidden from dropdowns in all projects without their own list. */
  hidden_models: string;
}

// ── Dashboard ────────────────────────────────────────────────────────────
// The /api/analytics response. It is computed by orc/analytics.py; here only the shape.

/** Time axis step: the server picks it by the period length, the client only labels it. */
export type AnalyticsBucket = "day" | "week" | "month";

/** Breakdown row: model, effort level, access mode or project. */
export interface AnalyticsRow {
  /** Breakdown key. "—" — not chosen on the cards, the project default applies. */
  key: string;
  tasks: number;
  done: number;
  failed: number;
  tokens: number;
  cost_usd: number;
  /** Median agent working time. null — none of the row's tasks had a session. */
  median_sec: number | null;
}

/** A piece of a bar stack: how many tasks, tokens and money fell on one breakdown key. */
export interface AnalyticsFlowCell {
  tasks: number;
  tokens: number;
  cost_usd: number;
}

/** Stack breakdown: by completion status, by model or by project. */
export type AnalyticsSplit = "by_status" | "by_model" | "by_project";

/** One time axis bucket: how many queued, how many closed, what it cost. */
export interface AnalyticsFlowRow {
  /** Bucket start, YYYY-MM-DD. */
  date: string;
  created: number;
  done: number;
  failed: number;
  tokens: number;
  cost_usd: number;
  /** The same completed tasks of the bucket in three breakdowns; the sum of cells equals the bucket total
   *  (for models — by tokens and money, while the task as a whole is recorded under the main model). */
  by_status: Record<string, AnalyticsFlowCell>;
  by_model: Record<string, AnalyticsFlowCell>;
  by_project: Record<string, AnalyticsFlowCell>;
}

/** Totals of the previous period of the same length: only what the tiles compare against. */
export interface AnalyticsPrevious {
  created: number;
  finished: number;
  done: number;
  failed: number;
  success_rate: number | null;
  tokens: number;
  cost_usd: number;
  work_p50_sec: number | null;
  interventions: number;
}

export interface AnalyticsDurationBin {
  label: string;
  from_sec: number;
  to_sec: number | null;
  count: number;
}

/** Duration distribution together with an honest scope: how many tasks it could be measured for at all. */
export interface AnalyticsDurations {
  /** Tasks with a usable session start mark. */
  measured: number;
  /** Completed tasks in the period — always at least measured. */
  finished: number;
  bins: AnalyticsDurationBin[];
}

/** "Most expensive" table row. */
export interface AnalyticsTopRow {
  id: number;
  title: string;
  status: TaskStatus;
  project: string | null;
  model: string;
  tokens: number;
  cost_usd: number | null;
  work_sec: number | null;
  finished_at: string;
}

export interface AnalyticsTotals {
  created: number;
  finished: number;
  done: number;
  failed: number;
  /** Success share among completed. null — nothing completed in the period. */
  success_rate: number | null;
  tokens: number;
  cost_usd: number;
  /** For how many tasks there is a price at all and for how many of them it is exact (from Claude Code). */
  cost_known_tasks: number;
  cost_exact_tasks: number;
  /** Lead time: from the card's creation to completion — includes lying in the backlog. */
  lead_p50_sec: number | null;
  lead_p90_sec: number | null;
  /** Work: from the first session start to completion — this is the agent's time. */
  work_p50_sec: number | null;
  work_p90_sec: number | null;
  retries: { resume: number; quota: number; conflict: number };
  /** How many times the agent called the human (input requests in the period). */
  interventions: number;
  interventions_by_kind: Partial<Record<InputKind, number>>;
  /** Median time it took the person to respond. null — there were no answered requests. */
  answer_wait_p50_sec: number | null;
}

/** Current board snapshot: it is about "what is happening now" and is not cut by the period. */
export interface AnalyticsSnapshot {
  by_status: Record<TaskStatus, number>;
  total: number;
  archived: number;
  in_flight: number;
  waiting: number;
  blocked: number;
  queued: number;
}

export interface Analytics {
  generated_at: string;
  period: { days: number; from: string; to: string; bucket: AnalyticsBucket };
  scope: { project_id: number | null; project: string | null };
  totals: AnalyticsTotals;
  /** null — the "all time" period: there is nothing to compare against. */
  previous: AnalyticsPrevious | null;
  now: AnalyticsSnapshot;
  flow: AnalyticsFlowRow[];
  durations: AnalyticsDurations;
  models: AnalyticsRow[];
  efforts: AnalyticsRow[];
  permissions: AnalyticsRow[];
  projects: AnalyticsRow[];
  top_cost: AnalyticsTopRow[];
}

/**
 * Limit forecast (orc/forecast.py). Window verdict: hit — already hit the limit; over — at the current
 * pace you will hit it before the reset; tight — you will make it, but barely; ok — there is headroom; unknown —
 * limits are unknown or the window has just started.
 */
export type ForecastVerdict = "ok" | "tight" | "over" | "hit" | "unknown";

/** Usage of one project within a limit window. */
export interface ForecastProject {
  project_id: number | null;
  project: string;
  tasks: number;
  tokens: number;
  cost_usd: number;
  /** Share of the orchestrator's usage over the window: by money, or by tokens if there are no prices. */
  share: number;
  /** Upper-bound estimate: how many percentage points of the limit the project could have consumed. */
  limit_pct_max: number | null;
  pace_tokens_per_hour: number;
  pace_cost_per_hour: number;
  projected_tokens: number;
  projected_cost_usd: number;
}

export interface ForecastSpend {
  measure: "cost" | "tokens";
  tokens: number;
  cost_usd: number;
  pace_tokens_per_hour: number;
  pace_cost_per_hour: number;
  /** Who to throttle first: who is spending fastest right now. */
  leader_project_id: number | null;
  projects: ForecastProject[];
}

export interface ForecastWindow {
  used_pct: number | null;
  /** Epoch seconds, as in UsageStatus. */
  resets_at: number | null;
  window_start: number | null;
  measured_at: number | null;
  pace_pct_per_hour: number | null;
  /** recent — by probes of the last hour (a day for the week); window — the average since the window start. */
  pace_basis: "recent" | "window" | null;
  avg_pct_per_hour: number | null;
  projected_pct: number | null;
  hits_limit_at: number | null;
  /** The pace at which the window ends exactly at the reset. */
  safe_pace_pct_per_hour: number | null;
  /** To what percentage of the current pace to slow down in order to make it to the reset. */
  slowdown_to_pct: number | null;
  verdict: ForecastVerdict;
  spend_since: string;
  spend: ForecastSpend;
}

export type ForecastWindowKey = "five_hour" | "seven_day";

export interface Forecast {
  generated_at: string;
  available: boolean;
  stale: boolean;
  updated_at: number | null;
  /** Since when the usage journal has been kept over time; before that — an estimate. */
  ledger_since: string | null;
  /** Windows the account does not have (see UsageStatus.absent). May not come from an old server. */
  absent?: ForecastWindowKey[];
  five_hour: ForecastWindow;
  seven_day: ForecastWindow;
}

/** Kind of a recurring task's schedule: every N minutes or a cron expression. */
export type RoutineScheduleKind = "interval" | "cron";

/** Outcome of a run's report.json — as the agent wrote it. */
export interface RunReport {
  status?: string;
  summary?: string;
  notes?: string;
}

/** One routine run in its history (orc/api/routines.py, _run_out). */
export interface RoutineRun {
  task_id: number;
  run: number | null;
  title: string;
  status: TaskStatus;
  blocker: Blocker;
  blocker_detail: string | null;
  created_at: string;
  started_at: string | null;
  done_at: string | null;
  updated_at: string;
  archived_at: string | null;
  report: RunReport | null;
  tokens: number | null;
}

/**
 * A recurring task: the statement and the schedule. Each run is a regular task on the board
 * with routine_id, so each has its own log, report and status.
 */
export interface Routine {
  id: number;
  project_id: number;
  title: string;
  description: string;
  priority: Priority;
  model: string | null;
  effort: string | null;
  permission_mode: PermissionMode | null;
  verify_cmd: string | null;
  target_branch: string | null;
  schedule_kind: RoutineScheduleKind;
  interval_minutes: number | null;
  cron: string | null;
  /** IANA time zone in which cron is read. null — UTC. */
  timezone: string | null;
  enabled: boolean;
  /** When the dispatcher will create the next run. null — the routine is paused. */
  next_run_at: string | null;
  last_run_at: string | null;
  run_count: number;
  skipped_count: number;
  /** Run cap: upon reaching it the routine pauses. null — no cap. */
  max_runs: number | null;
  /** Past completed runs go to the archive when a new one is created. */
  archive_runs: boolean;
  /** The schedule in human terms from the server: "every 2 h", "cron 0 9 * * 1-5 (Europe/Moscow)". */
  schedule_text: string;
  stats: { total: number; done: number; failed: number; active: number; skipped: number };
  last_run: RoutineRun | null;
  created_at: string;
  updated_at: string;
}

/** What the form sends when creating and editing a routine. */
export interface RoutineInput {
  title: string;
  description: string;
  priority: Priority;
  model: string | null;
  effort: string | null;
  permission_mode: PermissionMode | null;
  verify_cmd: string | null;
  schedule_kind: RoutineScheduleKind;
  interval_minutes: number | null;
  cron: string | null;
  timezone: string | null;
  max_runs: number | null;
  archive_runs: boolean;
}

/** The nearest scheduled runs, computed by the server. */
export interface SchedulePreview {
  next: string[];
  text: string;
}
