import type { Analytics, Attachment, Forecast, Routine, RoutineInput, RoutineRun, SchedulePreview, BranchesView, WorktreesView, ClaudeMd, ClaudeMdFile, ClaudeMdLocation, Comment, DispatcherStatus, InputDecision, OrcEvent, Project, ProjectMoveResult, ProjectPathCheck, Settings, Task, TaskDetail, UsageStatus } from "./types";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The server puts the dashboard token into <meta> when serving the page (orc/server.py): this way
// it ends up neither in the browser history nor in localStorage. Without it, mutating requests get
// 403.
const token = document.querySelector<HTMLMetaElement>('meta[name="orc-token"]')?.content ?? "";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { "x-orc-token": token } : {}), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      // the body is not JSON, keep the status code
    }
    throw new ApiError(res.status, detail);
  }
  // A successful response that does not parse as JSON means exactly one thing: the server has no
  // such endpoint, and the request hit the SPA fallback (`/{path:path}` serves index.html). This is
  // what a freshly built frontend on top of a server running old code looks like. Without this
  // trap, "Unexpected token '<', "<!doctype "... is not valid JSON" would leak out, a message that
  // gives no hint that the server needs a restart.
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(
      res.status,
      `The server doesn't know ${url}: got the control room page back instead of data. ` +
        "It looks like the server is running an old build — restart it (make restart).",
    );
  }
}

const get = <T>(url: string) => request<T>(url);
const post = <T>(url: string, body?: unknown) => request<T>(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(url: string, body: unknown) => request<T>(url, { method: "PATCH", body: JSON.stringify(body) });
const put = <T>(url: string, body: unknown) => request<T>(url, { method: "PUT", body: JSON.stringify(body) });
const del = <T>(url: string) => request<T>(url, { method: "DELETE" });

function query(params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return q ? `?${q}` : "";
}

export const api = {
  // archived: hide (the server default) | only | all. The dashboard uses all: it needs archived
  // projects in the same response to show them as a separate sidebar section.
  listProjects: (params: { archived?: "hide" | "only" | "all" } = {}) => get<Project[]>(`/api/projects${query(params)}`),
  // init_git is consent to create a repository in an empty place: it arrives only after
  // confirmation in the dialog (see checkProjectPath).
  addProject: (body: Partial<Project> & { name: string; path: string; init_git?: boolean }) =>
    post<Project>("/api/projects", body),
  // Path reconnaissance BEFORE creating a project: whether the folder exists and has git. It is
  // needed to tell "not allowed" apart from "nothing there yet, but one can be created" and to show
  // the latter as a choice, not a refusal.
  checkProjectPath: (path: string) => post<ProjectPathCheck>("/api/projects/check-path", { path }),
  patchProject: (id: number, body: Partial<Project>) => patch<Project>(`/api/projects/${id}`, body),
  // Moving a project to another folder: the server repairs task worktrees and re-links their paths,
  // and the response says how many copies were re-linked and what was not found at the new
  // location.
  moveProject: (id: number, path: string) => post<ProjectMoveResult>(`/api/projects/${id}/path`, { path }),
  // Archiving a project is reversible and deletes nothing: the board does not show it, the
  // dispatcher does not take its tasks, data and branches stay intact.
  archiveProject: (id: number) => post<Project>(`/api/projects/${id}/archive`),
  unarchiveProject: (id: number) => post<Project>(`/api/projects/${id}/unarchive`),
  // Project memory file. A write goes strictly after a read: prev_sha is a fingerprint of what the
  // human was editing, and a 409 response means the file was changed behind the dashboard's back in
  // the meantime.
  claudeMd: (projectId: number) => get<ClaudeMd>(`/api/projects/${projectId}/claude-md`),
  saveClaudeMd: (projectId: number, body: { location: ClaudeMdLocation; content: string; prev_sha: string | null }) =>
    put<ClaudeMdFile>(`/api/projects/${projectId}/claude-md`, body),
  // Project branches together with the binding to tasks: the interface uses it to know what can be
  // touched and what would break running work (the server computes the prohibitions, see
  // orc/branches.py).
  branches: (projectId: number) => get<BranchesView>(`/api/git/branches${query({ project_id: projectId })}`),
  createBranch: (projectId: number, name: string, base: string | null) =>
    post<BranchesView>("/api/git/branches", { project_id: projectId, name, base }),
  renameBranch: (projectId: number, name: string, newName: string) =>
    post<BranchesView>("/api/git/branches/rename", { project_id: projectId, name, new_name: newName }),
  // force=true confirms warnings (unmerged commits, tasks waiting for this base). It does not
  // bypass prohibitions: the server will still answer 400.
  deleteBranch: (projectId: number, name: string, force = false) =>
    post<BranchesView>("/api/git/branches/delete", { project_id: projectId, name, force }),
  // Working copies in .claude/worktrees: whose they are, how much they weigh, whether they are
  // merged, who works in them. The server computes sizes with du; on dozens of copies that takes
  // seconds, so only on request.
  worktrees: (projectId: number) => get<WorktreesView>(`/api/git/worktrees${query({ project_id: projectId })}`),
  // force=true confirms warnings. Blocked copies in a batch are skipped by the server and named in
  // note, rather than failing the whole operation.
  deleteWorktrees: (projectId: number, names: string[], force = false) =>
    post<WorktreesView>("/api/git/worktrees/delete", { project_id: projectId, names, force }),

  // archived: hide (the server default) | only | all. The dashboard always uses all and splits them
  // itself: the "Archive" toggle must not cost a second poll.
  listTasks: (params: { project_id?: number; status?: string; archived?: "hide" | "only" | "all" } = {}) =>
    get<Task[]>(`/api/tasks${query(params)}`),
  getTask: (id: number) => get<TaskDetail>(`/api/tasks/${id}`),
  addTask: (body: Partial<Task> & { project_id: number; title: string }) => post<TaskDetail>("/api/tasks", body),
  // force=true confirms the emergency close of a stuck task (see FORCE_MOVES in orc/api.py). This
  // is not a task field: it is not written to the database, it only permits the transition.
  patchTask: (id: number, body: Partial<Task> & { status?: string; blocker?: null; force?: boolean }) =>
    patch<TaskDetail>(`/api/tasks/${id}`, body),
  addComment: (id: number, body: string, kind: Comment["kind"], mode?: "soft" | "interrupt") =>
    post<TaskDetail>(`/api/tasks/${id}/comments`, { body, kind, ...(mode ? { mode } : {}) }),
  // Decision on an input request (permission, answer to a question, plan approval). The session is
  // not stopped meanwhile: the decision is picked up by the hook holding the tool
  // (docs/internals/input-requests.md).
  answerInput: (id: number, requestId: number, decision: InputDecision) =>
    post<TaskDetail>(`/api/tasks/${id}/input-requests/${requestId}/answer`, { decision }),
  // The backend returns asdict(task) without depends_on (see orc/api.py:288, 296): the type must
  // not lie about this field.
  retry: (id: number) => post<Omit<Task, "depends_on">>(`/api/tasks/${id}/retry`),
  resume: (id: number) => post<Omit<Task, "depends_on">>(`/api/tasks/${id}/resume`),
  // Explicit trust in the project folder (untrusted blocker) and rerunning the task, instead of
  // going to the terminal to accept Claude Code's trust dialog by hand.
  trustAndRetry: (id: number) => post<Omit<Task, "depends_on">>(`/api/tasks/${id}/trust`),
  // Result viewing (viewing.ts): true means "I have seen this", false returns it to unviewed.
  markViewed: (id: number, viewed: boolean) => post<TaskDetail>(`/api/tasks/${id}/viewed`, { viewed }),
  // "Mark all": all finished tasks of the project become viewed at once.
  markAllViewed: (projectId: number) => post<{ viewed: number }>(`/api/projects/${projectId}/mark-viewed`),
  // Archiving is reversible: the task leaves the board entirely, with its conversation, report and
  // branch.
  archive: (id: number) => post<TaskDetail>(`/api/tasks/${id}/archive`),
  unarchive: (id: number) => post<TaskDetail>(`/api/tasks/${id}/unarchive`),
  // Deletion is irreversible. force confirms deleting a running task (its session will be cut off);
  // dropWorktree=false leaves the branch and the working copy untouched.
  deleteTask: (id: number, opts: { force?: boolean; dropWorktree?: boolean } = {}) =>
    del<{ deleted: number; session: boolean; worktree: boolean; branch: boolean; dependents: number[] }>(
      `/api/tasks/${id}${query({ force: opts.force ? 1 : undefined, drop_worktree: opts.dropWorktree === false ? 0 : undefined })}`,
    ),

  // The image travels as a base64 string in ordinary JSON: multipart for a single endpoint is not
  // worth the python-multipart dependency on the backend.
  uploadAttachment: (body: { filename: string; mime: string; data: string }) =>
    post<Attachment>("/api/attachments", body),

  // Recurring tasks (orc/api/routines.py): a template and a schedule; each run is an ordinary task.
  routines: (projectId?: number) => get<Routine[]>(`/api/routines${query({ project_id: projectId })}`),
  addRoutine: (body: RoutineInput & { project_id: number; enabled?: boolean }) => post<Routine>("/api/routines", body),
  patchRoutine: (id: number, body: Partial<RoutineInput> & { enabled?: boolean }) => patch<Routine>(`/api/routines/${id}`, body),
  // Routine runs stay on the board as ordinary tasks: only the schedule is deleted.
  deleteRoutine: (id: number) => del<{ deleted: number }>(`/api/routines/${id}`),
  // "Run now": an out-of-schedule run, the schedule does not shift. 409 means the previous run is
  // still going.
  runRoutine: (id: number) => post<{ task_id: number; routine: Routine }>(`/api/routines/${id}/run`),
  routineRuns: (id: number) => get<RoutineRun[]>(`/api/routines/${id}/runs`),
  // Schedule check before saving: the server computes the nearest runs with the same code as the
  // dispatcher.
  previewSchedule: (body: Pick<RoutineInput, "schedule_kind" | "interval_minutes" | "cron" | "timezone">) =>
    post<SchedulePreview>("/api/routines/preview", body),

  events: (unread = false) => get<OrcEvent[]>(`/api/events${query({ unread: unread ? 1 : undefined })}`),
  markEventsRead: () => post<{ ok: boolean }>("/api/events/read"),

  // Account limits (5h/week) from the orchestrator cache (see orc/usage.py).
  usage: () => get<UsageStatus>("/api/usage"),
  // The "refresh" button: the server asks Claude for the limits with a probe request and returns
  // fresh values. It takes several seconds: this is a real trip to the model, not a file re-read.
  refreshUsage: () => post<UsageStatus>("/api/usage/refresh"),

  dispatcher: () => get<DispatcherStatus>("/api/dispatcher"),
  pause: () => post<DispatcherStatus>("/api/dispatcher/pause"),
  resumeDispatcher: () => post<DispatcherStatus>("/api/dispatcher/resume"),
  tick: () => post<DispatcherStatus>("/api/dispatcher/tick"),

  // Dashboard summary. project_id not set means a slice across all projects, days=0 means all time.
  // The server computes it in a single pass over the tasks (orc/analytics.py): the client receives
  // ready aggregates, not a thousand cards that would have to be summed in the browser.
  analytics: (params: { project_id?: number; days: number }) => get<Analytics>(`/api/analytics${query(params)}`),
  // Limits forecast and per-project consumption inside the windows (orc/forecast.py). The limit is
  // shared across the account, so the endpoint has no per-project slice.
  forecast: () => get<Forecast>("/api/forecast"),

  settings: () => get<Settings>("/api/settings"),
  patchSettings: (body: Partial<Settings>) => patch<Settings>("/api/settings", body),
};
