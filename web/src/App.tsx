import { useEffect, useMemo, useRef, useState } from "react";
import { PlugZap } from "lucide-react";
import { Toaster, toast } from "sonner";
import { api } from "./api";
import { usePolling } from "./hooks/usePolling";
import { useUiState } from "./hooks/useUiState";
import { needsAttention } from "./status";
import { isUnviewed, tracksViewed } from "./viewing";
import { Board, getColumns } from "./components/Board";
import { Dashboard } from "./components/Dashboard";
import { RoutinesView } from "./components/RoutinesView";
import { AttentionBar } from "./components/AttentionBar";
import { ProjectAlert } from "./components/ProjectAlert";
import { BranchesDialog } from "./components/BranchesDialog";
import { WorktreesDialog } from "./components/WorktreesDialog";
import { EmptyDescriptionDialog } from "./components/EmptyDescriptionDialog";
import { ProjectDialog } from "./components/ProjectDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { TaskForm } from "./components/TaskForm";
import { TaskModal } from "./components/TaskModal";
import { TopBar } from "./components/TopBar";
import { HelpPages, type HelpPage } from "./components/help/HelpPages";
import { Modal } from "./ui/Modal";
import { Confirm } from "./ui/Confirm";
import { Button } from "./ui/Button";
import { OrcMark } from "./brand/OrcMark";
import { statusLabel } from "./labels";
import { useTranslation } from "./i18n";
import { parseHiddenModels } from "./models";
import { AppHiddenModelsContext } from "./hiddenModels";
import type { Task, TaskStatus } from "./types";

export default function App() {
  const { t } = useTranslation();
  const { ui, setUi } = useUiState();
  // Search lives only in the current session: a filter restored after a restart would look like
  // "half of the tasks vanished".
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [dispatcherPending, setDispatcherPending] = useState(false);
  const [usagePending, setUsagePending] = useState(false);
  const [projectActionPending, setProjectActionPending] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  // Help page instead of the board. Not remembered across restarts: opening the dashboard and
  // landing on help instead of tasks would be odd.
  const [helpPage, setHelpPage] = useState<HelpPage | null>(null);
  // null inside the object means creating a project; undefined means the dialog is closed.
  const [projectDialog, setProjectDialog] = useState<{ id: number | null } | null>(null);
  // Emergency close of a stuck task: the move is not sent to the server until the person confirms
  // it in the dialog. null means the dialog is closed.
  const [forceMove, setForceMove] = useState<{ task: Task; to: TaskStatus } | null>(null);
  const [forcePending, setForcePending] = useState(false);
  // A card without a task description is not sent to work: instead of the move we show a dialog
  // with an explanation. null means the dialog is closed.
  const [emptyDesc, setEmptyDesc] = useState<Task | null>(null);
  // A card opened for repair from this dialog must open straight in the editor: after a rejection
  // the person needs a text field, not one more click on the pencil.
  const [openInEditor, setOpenInEditor] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // archived=all: archived projects arrive with the same poll and are split out on the client; a
  // separate request for the "Archive" sidebar section would double the polling.
  const projects = usePolling(() => api.listProjects({ archived: "all" }), 10000);
  const dispatcher = usePolling(() => api.dispatcher(), 5000);
  // Account limits change slowly and not in response to actions in this UI, so a one-second poll is
  // unnecessary; minutes are enough. The button in the left column makes the server ask Claude for
  // the limits right now.
  const usage = usePolling(() => api.usage(), 60000);
  // The archive arrives with the same poll (archived=all) and is split out on the client: a
  // separate request for the "Archive" toggle would double the polling for a rarely needed view.
  const tasks = usePolling(() => api.listTasks({ archived: "all" }), 5000);
  // The board needs orc settings for one thing: which models are hidden from the dropdowns (see
  // hiddenModels.ts). They change only from the settings dialog, which asks for an immediate
  // re-read after saving, so a rare poll is enough: it picks up edits from another tab.
  const settings = usePolling(() => api.settings(), 60000);
  const appHiddenModels = useMemo(() => parseHiddenModels(settings.data?.hidden_models), [settings.data]);

  const list = useMemo(() => projects.data ?? [], [projects.data]);
  // Working projects are those not archived: the default project comes from them, and they decide
  // whether there is anything to work with at all. Archived ones stay reachable by click.
  const activeProjects = useMemo(() => list.filter((p) => !p.archived_at), [list]);
  const allTasks = useMemo(() => tasks.data ?? [], [tasks.data]);
  // Everything except the board in the archived view counts only live tasks: a removed card does
  // not wait for a human, does not occupy a worker and is not valid as a blocker for a new task.
  const liveTasks = useMemo(() => allTasks.filter((t) => !t.archived_at), [allTasks]);

  // The selected project is restored from the saved state. The first one in the list is only a
  // fallback: for the very first launch and for the case when the saved project was deleted.
  const stored = ui.projectId !== null ? list.find((p) => p.id === ui.projectId) ?? null : null;
  const current = stored ?? activeProjects[0] ?? null;
  const currentId = current?.id ?? null;
  // A task cannot be put into a project whose folder has disappeared or which has been archived:
  // the server rejects such a request (409), and offering the form would be misleading.
  const canCreateTask = current !== null && current.path_ok && !current.archived_at;

  // The summary is polled only while it is on screen: every response is a full pass over the tasks
  // on the server, and spinning it in the background for a tab nobody is looking at is pointless. A
  // change of scope or period goes into deps and refetches immediately.
  const dashboardOn = ui.view === "dashboard";
  const dashProjectId = ui.dashAllProjects ? undefined : currentId ?? undefined;
  const analytics = usePolling(
    () => (dashboardOn ? api.analytics({ days: ui.dashDays, project_id: dashProjectId }) : Promise.resolve(null)),
    30000,
    [dashboardOn, dashProjectId, ui.dashDays],
  );
  // Limits forecast while the dashboard is open: it has no toggle, the block is always visible. A
  // minute is enough: limits change no faster than the left column polls them.
  const forecast = usePolling(
    () => (dashboardOn ? api.forecast() : Promise.resolve(null)),
    60000,
    [dashboardOn],
  );

  // Clean up the saved value when the project has really disappeared: otherwise it would quietly
  // "miss" on every launch.
  useEffect(() => {
    if (projects.data === null || list.length === 0) return;
    if (ui.projectId !== null && !list.some((p) => p.id === ui.projectId)) {
      // The replacement is a working project: substituting an archived one for the vanished value
      // would open a board where nothing can be done.
      setUi({ projectId: (activeProjects[0] ?? list[0]).id });
    }
  }, [projects.data, list, activeProjects, ui.projectId, setUi]);

  // The same for an open task: a link to a deleted task must not leave a "Loading…" dialog hanging
  // on every start.
  useEffect(() => {
    if (tasks.data === null || ui.openTaskId === null) return;
    if (!allTasks.some((t) => t.id === ui.openTaskId)) setUi({ openTaskId: null });
  }, [tasks.data, allTasks, ui.openTaskId, setUi]);

  // The connection to the server could break on any of the three polls: we show the first error
  // that comes up without waiting for all three to fail (see usePolling: an error does not erase
  // previous data).
  const connectionError = projects.error ?? tasks.error ?? dispatcher.error;

  const attention = useMemo(
    () => liveTasks.filter((t) => t.project_id === currentId && needsAttention(t)),
    [liveTasks, currentId],
  );
  // There is one dispatcher for all projects, so a task stuck in a neighbouring project must be
  // visible from here too: otherwise you learn about it only after switching.
  const attentionElsewhere = useMemo(
    () => liveTasks.filter((t) => t.project_id !== currentId && needsAttention(t)),
    [liveTasks, currentId],
  );
  const archivedCount = useMemo(
    () => allTasks.filter((t) => t.archived_at && t.project_id === currentId).length,
    [allTasks, currentId],
  );
  // Result viewing is tracked not in every project (project setting, see viewing.ts): where it is
  // off, there is no counter on "Done" and no marks on cards.
  const viewingOn = tracksViewed(current);
  const unviewedCount = useMemo(
    () => (viewingOn ? liveTasks.filter((t) => t.project_id === currentId && isUnviewed(t)).length : 0),
    [viewingOn, liveTasks, currentId],
  );
  const live = (dispatcher.data?.running ?? 0) > 0 && !(dispatcher.data?.paused ?? false);

  // Shared action handler: success clears earlier complaints, failure shows a toast and keeps the
  // promise from flying away unhandled.
  const runAction = (action: () => Promise<unknown>, onSuccess?: () => void) => {
    action()
      .then(() => onSuccess?.())
      .catch((e: unknown) => {
        toast.error(e instanceof Error ? e.message : String(e));
      });
  };

  // Archiving a project right from the banner: the result is visible only after re-reading the
  // list, so we refresh it ourselves instead of waiting for the next poll.
  const runProjectAction = (action: () => Promise<unknown>) => {
    setProjectActionPending(true);
    action()
      .then(() => projects.refresh())
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setProjectActionPending(false));
  };

  /** Open a task card: from any list, from an event header, or via the "after #N" badge link in
   * another card. The board also switches to the task's project: a dependency may lie in a
   * neighbouring project, and the open dialog would otherwise hang over someone else's board. */
  const openTask = (id: number) => {
    const task = allTasks.find((t) => t.id === id);
    setUi(task ? { openTaskId: id, projectId: task.project_id } : { openTaskId: id });
  };

  const refreshUsage = () => {
    setUsagePending(true);
    // First ask the server to go to Claude, then re-read: without the second step usePolling would
    // be left with the previous tick's answer.
    api
      .refreshUsage()
      .catch(() => undefined)
      .then(() => usage.refresh())
      .finally(() => setUsagePending(false));
  };

  const runDispatcherAction = (action: () => Promise<unknown>) => {
    setDispatcherPending(true);
    action()
      .then(() => dispatcher.refresh())
      .catch((e: unknown) => {
        toast.error(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setDispatcherPending(false));
  };

  // Hotkeys. They work only when focus is not in an input field and no dialog is open: otherwise
  // "n" could not be typed in a task description.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el?.isContentEditable;
      if (typing) return;
      if (document.querySelector("[role=dialog]")) return;

      // The Cyrillic key aliases below are the same physical keys as n, [, e and d
      // on the Russian keyboard layout, so the hotkeys work with that layout active.
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "n" || e.key === "т") {
        if (!canCreateTask) return;
        e.preventDefault();
        setCreating(true);
      } else if (e.key === "[" || e.key === "х") {
        e.preventDefault();
        setUi({ sidebarCollapsed: !ui.sidebarCollapsed });
      } else if (e.key === "e" || e.key === "у") {
        e.preventDefault();
        setEventsOpen((v) => !v);
      } else if (e.key === "d" || e.key === "в") {
        e.preventDefault();
        setHelpPage(null);
        setUi({ view: ui.view === "dashboard" ? "board" : "dashboard" });
      } else if (e.key === "?" || (e.shiftKey && e.code === "Slash")) {
        // On the Russian layout the same key with Shift gives a comma, not "?", so, as with the
        // letters above, we also catch the physical key.
        e.preventDefault();
        setHelpPage((p) => (p === "guide" ? null : "guide"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canCreateTask, ui.sidebarCollapsed, ui.view, setUi]);

  const editedProject = projectDialog?.id != null ? list.find((p) => p.id === projectDialog.id) ?? null : null;

  return (
    <AppHiddenModelsContext.Provider value={appHiddenModels}>
      <div className="flex h-full overflow-hidden bg-[var(--canvas)]">
        <Sidebar
          projects={list}
          tasks={liveTasks}
          currentId={currentId}
          collapsed={ui.sidebarCollapsed}
          usage={usage.data}
          onUsageRefresh={refreshUsage}
          usagePending={usagePending}
          dispatcher={dispatcher.data}
          onPause={() => runDispatcherAction(() => api.pause())}
          onResume={() => runDispatcherAction(() => api.resumeDispatcher())}
          onTick={() => runDispatcherAction(() => api.tick().then(() => tasks.refresh()))}
          dispatcherPending={dispatcherPending}
          eventsOpen={eventsOpen}
          onEventsOpen={setEventsOpen}
          onOpenTask={(id) => {
            setEventsOpen(false);
            openTask(id);
          }}
          awake={dispatcher.data !== null && !dispatcher.data.paused}
          working={live}
          onSelect={(id) => {
            setHelpPage(null);
            setUi({ projectId: id });
          }}
          onReorderProjects={(orderedIds) => {
            // Same approach as with tasks on the board (see onReorder below): positions with a
            // step, not by one, so the fresh order is guaranteed to win over old position values.
            const changed = orderedIds
              .map((id, i) => ({ id, position: (i + 1) * 10 }))
              .filter(({ id, position }) => list.find((p) => p.id === id)?.position !== position);
            if (changed.length === 0) return;
            runAction(
              () => Promise.all(changed.map(({ id, position }) => api.patchProject(id, { position }))),
              () => void projects.refresh(),
            );
          }}
          onToggleCollapsed={() => setUi({ sidebarCollapsed: !ui.sidebarCollapsed })}
          onAddProject={() => setProjectDialog({ id: null })}
          onOpenSettings={() => setSettingsOpen(true)}
          helpPage={helpPage}
          onOpenHelp={setHelpPage}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {helpPage ? (
            <HelpPages
              page={helpPage}
              onPage={setHelpPage}
              onClose={() => setHelpPage(null)}
              onAddProject={() => setProjectDialog({ id: null })}
            />
          ) : (
            <>
              <TopBar
                ref={searchRef}
                project={current}
                view={ui.view}
                onView={(view) => setUi({ view })}
                search={search}
                onSearch={setSearch}
                attentionOnly={ui.attentionOnly}
                onAttentionOnly={(v) => setUi({ attentionOnly: v })}
                attentionCount={attention.length}
                showDone={ui.showDone}
                onShowDone={(v) => setUi({ showDone: v })}
                showArchived={ui.showArchived}
                onShowArchived={(v) => setUi({ showArchived: v })}
                archivedCount={archivedCount}
                unviewedCount={unviewedCount}
                onProjectSettings={() => currentId !== null && setProjectDialog({ id: currentId })}
                onOpenBranches={() => setBranchesOpen(true)}
                onOpenWorktrees={() => setWorktreesOpen(true)}
                canCreateTask={canCreateTask}
                onCreateTask={() => setCreating(true)}
                live={live}
              />

              {connectionError && (
                <p className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_oklab,var(--danger)_30%,var(--line))] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-1.5 text-[12px] text-[var(--danger)]">
                  <PlugZap size={13} aria-hidden />
                  {t("app.connectionError", { error: String(connectionError) })}
                </p>
              )}

              {current && (
                <ProjectAlert
                  project={current}
                  pending={projectActionPending}
                  onOpenSettings={() => setProjectDialog({ id: current.id })}
                  onArchive={() => runProjectAction(() => api.archiveProject(current.id))}
                  onUnarchive={() => runProjectAction(() => api.unarchiveProject(current.id))}
                />
              )}

              {!ui.attentionOnly && (
                <AttentionBar
                  tasks={attention}
                  elsewhere={attentionElsewhere}
                  onOpen={openTask}
                />
              )}

              <section className="min-h-0 flex-1 overflow-hidden p-3">
                {ui.view === "dashboard" ? (
                  <Dashboard
                    data={analytics.data}
                    error={analytics.error}
                    project={current}
                    // Without a selected project there is nothing to slice the summary by, so we
                    // show everything at once.
                    allProjects={ui.dashAllProjects || currentId === null}
                    onAllProjects={(dashAllProjects) => setUi({ dashAllProjects })}
                    days={ui.dashDays}
                    onDays={(dashDays) => setUi({ dashDays })}
                    metric={ui.dashMetric}
                    onMetric={(dashMetric) => setUi({ dashMetric })}
                    split={ui.dashSplit}
                    onSplit={(dashSplit) => setUi({ dashSplit })}
                    breakdown={ui.dashBreakdown}
                    onBreakdown={(dashBreakdown) => setUi({ dashBreakdown })}
                    onRefresh={() => {
                      void analytics.refresh();
                      void forecast.refresh();
                    }}
                    onOpenTask={openTask}
                    forecast={forecast.data}
                    forecastError={forecast.error}
                  />
                ) : ui.view === "routines" && current ? (
                  // Project routines: their runs are ordinary cards, so they open in the same task
                  // dialog as from the board.
                  <RoutinesView
                    key={current.id}
                    project={current}
                    canCreate={canCreateTask}
                    onOpenTask={openTask}
                    onTasksChanged={() => void tasks.refresh()}
                  />
                ) : projects.data === null && projects.error ? (
                  <EmptyState
                    title={t("app.serverNotRespondingTitle")}
                    body={t("app.serverNotRespondingBody")}
                  />
                ) : projects.data === null || (currentId !== null && tasks.data === null) ? (
                  <BoardSkeleton />
                ) : currentId === null ? (
                  <EmptyState
                    title={list.length > 0 ? t("app.allArchivedTitle") : t("app.noProjectsTitle")}
                    body={list.length > 0 ? t("app.allArchivedBody") : t("app.noProjectsBody")}
                    action={
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button variant="primary" onClick={() => setProjectDialog({ id: null })}>
                          {t("app.addProject")}
                        </Button>
                        <Button onClick={() => setHelpPage("guide")}>{t("pages.nav.guide")}</Button>
                      </div>
                    }
                  />
                ) : (
                  <Board
                    projectId={currentId}
                    tasks={allTasks}
                    search={search}
                    attentionOnly={ui.attentionOnly}
                    showDone={ui.showDone}
                    showArchived={ui.showArchived}
                    doneSort={ui.doneSort}
                    onDoneSortChange={(doneSort) => setUi({ doneSort })}
                    viewing={
                      viewingOn
                        ? {
                            onToggle: (id, viewed) => runAction(() => api.markViewed(id, viewed), () => void tasks.refresh()),
                            onMarkAll: () =>
                              runAction(() =>
                                api.markAllViewed(currentId).then(({ viewed }) => {
                                  void tasks.refresh();
                                  toast.success(t("viewing.markAllToast", { count: viewed }));
                                }),
                              ),
                          }
                        : undefined
                    }
                    onMove={(id, status, force) => {
                      const task = allTasks.find((t) => t.id === id);
                      // An ordinary move goes out immediately; an emergency one only after
                      // confirmation: it stops the session and closes the task bypassing
                      // verification and merge.
                      if (force && task) {
                        setForceMove({ task, to: status });
                        return;
                      }
                      runAction(() => api.patchTask(id, { status }), () => void tasks.refresh());
                    }}
                    onReorder={(_status, orderedIds) => {
                      // Positions are overwritten with a step, not by one: there is no need to
                      // renumber the whole column every time, and this way the fresh order is
                      // guaranteed to win over old position values, whatever they were.
                      const changed = orderedIds
                        .map((id, i) => ({ id, position: (i + 1) * 10 }))
                        .filter(({ id, position }) => allTasks.find((t) => t.id === id)?.position !== position);
                      if (changed.length === 0) return;
                      runAction(
                        () => Promise.all(changed.map(({ id, position }) => api.patchTask(id, { position }))),
                        () => void tasks.refresh(),
                      );
                    }}
                    onEmptyDescription={setEmptyDesc}
                    onOpen={openTask}
                    onCreate={() => setCreating(true)}
                  />
                )}
              </section>
            </>
          )}
        </main>

        {ui.openTaskId !== null && (
          <TaskModal
            key={`${ui.openTaskId}:${openInEditor}`}
            taskId={ui.openTaskId}
            allTasks={liveTasks}
            projects={list}
            initialEditing={openInEditor}
            onOpenTask={openTask}
            onClose={() => {
              setUi({ openTaskId: null });
              setOpenInEditor(false);
            }}
            onChanged={tasks.refresh}
          />
        )}

        {emptyDesc && (
          <EmptyDescriptionDialog
            open
            taskId={emptyDesc.id}
            taskTitle={emptyDesc.title}
            onClose={() => setEmptyDesc(null)}
            onFix={() => {
              setUi({ openTaskId: emptyDesc.id, projectId: emptyDesc.project_id });
              setOpenInEditor(true);
              setEmptyDesc(null);
            }}
          />
        )}

        {creating && currentId !== null && (
          <Modal open onOpenChange={(o) => !o && setCreating(false)} title={t("app.newTaskTitle")} size="lg" sticky>
            <TaskForm
              projectId={currentId}
              project={current}
              projects={list}
              allTasks={liveTasks}
              submitLabel={t("app.createTaskSubmit")}
              onCancel={() => setCreating(false)}
              pending={createPending}
              onSubmit={(v) => {
                setCreatePending(true);
                // .finally is on the request's own promise, not on runAction: we leave its error
                // handling alone and just clear the local pending flag when the request finishes
                // (successfully or not).
                runAction(
                  () => api.addTask({ project_id: currentId, ...v }).finally(() => setCreatePending(false)),
                  () => {
                    setCreating(false);
                    void tasks.refresh();
                  },
                );
              }}
            />
          </Modal>
        )}

        {forceMove && (
          <Confirm
            open
            title={t("app.forceCloseTitle")}
            confirmLabel={t("app.forceCloseConfirm")}
            pending={forcePending}
            onCancel={() => setForceMove(null)}
            onConfirm={() => {
              setForcePending(true);
              const { task, to } = forceMove;
              runAction(
                () =>
                  api
                    .patchTask(task.id, { status: to, force: true })
                    .finally(() => setForcePending(false)),
                () => {
                  setForceMove(null);
                  void tasks.refresh();
                  toast.success(t("app.forceCloseToast", { id: task.id }));
                },
              );
            }}
          >
            <p>{t("app.forceCloseBody1", { id: forceMove.task.id, status: statusLabel(t, forceMove.task.status) })}</p>
            <p className="text-[var(--ink-muted)]">
              {t("app.forceCloseBody2", { branch: forceMove.task.branch ?? t("app.forceCloseBranchFallback") })}
            </p>
          </Confirm>
        )}

        {/* Branches live in git, not in the database, so the dialog reads them itself and asks
           to re-read the board after every operation: a branch edit could have rewritten the
           cards' target_branch. */}
        {branchesOpen && currentId !== null && (
          <BranchesDialog
            open
            onOpenChange={setBranchesOpen}
            projectId={currentId}
            defaultBranch={current?.default_branch ?? null}
            tasks={allTasks}
            onChanged={() => {
              void tasks.refresh();
              void projects.refresh();
            }}
          />
        )}

        {/* Working copies also live on disk, not in the database: the dialog reads them itself. */}
        {worktreesOpen && currentId !== null && (
          <WorktreesDialog
            open
            onOpenChange={setWorktreesOpen}
            projectId={currentId}
            onOpenTask={openTask}
            onChanged={() => void tasks.refresh()}
          />
        )}

        {projectDialog && (
          <ProjectDialog
            open
            onOpenChange={(o) => !o && setProjectDialog(null)}
            project={editedProject}
            onSaved={(p) => {
              void projects.refresh();
              setUi({ projectId: p.id });
              toast.success(projectDialog.id === null ? t("app.projectAddedToast") : t("app.settingsSavedToast"));
            }}
          />
        )}

        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          theme={ui.theme}
          onThemeChange={(theme) => setUi({ theme })}
          onSaved={() => void settings.refresh()}
        />

        {/* Server rejections are shown as toasts: they used to settle in a small red line in the
           header, where they were easy to miss. The Toaster lives here, not in main.tsx, so
           that the app is fully responsible for its own messages, including when it is mounted
           in a test. */}
        <Toaster
          position="bottom-right"
          theme={ui.theme}
          closeButton
          toastOptions={{
            style: {
              background: "var(--raised)",
              border: "1px solid var(--line)",
              color: "var(--ink)",
              fontFamily: "inherit",
              fontSize: "13px",
            },
          }}
        />
      </div>
    </AppHiddenModelsContext.Provider>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      {/* Sleeping orc: the eyes are dark, there is no work. The mark is muted so as not to
         compete with the text. */}
      <OrcMark size={56} className="mb-2 text-[var(--ink-faint)]" />
      <p className="text-[14px] font-semibold text-[var(--ink)]">{title}</p>
      <p className="max-w-80 text-[12px] leading-relaxed text-[var(--ink-muted)]">{body}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Board placeholder for the time of the first /api/tasks response: it repeats the shape of the
 * columns so there is no layout jump when the data arrives. */
function BoardSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full gap-2.5 overflow-x-auto pb-1" aria-hidden="true">
      {getColumns(t).map((c) => (
        <div key={c.key} className="flex h-full min-w-[12.5rem] max-w-[22rem] flex-1 flex-col rounded-[var(--radius)] bg-[var(--sunken)]">
          <div className="flex h-9 items-center gap-2 px-2.5 text-[12px] font-semibold text-[var(--ink-faint)]">
            {c.title}
          </div>
          <div className="flex flex-col gap-1.5 px-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface)]" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
