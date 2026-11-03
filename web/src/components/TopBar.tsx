import { forwardRef } from "react";
import { Archive, CheckCheck, FolderGit2, GitBranch, Plus, Search, Settings2, X, type LucideIcon } from "lucide-react";
import { Horn } from "../brand/glyphs";
import type { Project } from "../types";
import type { View } from "../hooks/useUiState";
import { Button, IconButton } from "../ui/Button";
import { Segmented } from "../ui/Segmented";
import { fieldBase, focusRing } from "../ui/tokens";
import { Tip } from "../ui/Overlays";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";

interface Props {
  project: Project | null;
  /** Board or dashboard: board filters are not needed on the summary and are hidden. */
  view: View;
  onView: (value: View) => void;
  search: string;
  onSearch: (value: string) => void;
  attentionOnly: boolean;
  onAttentionOnly: (value: boolean) => void;
  attentionCount: number;
  showDone: boolean;
  onShowDone: (value: boolean) => void;
  /** Archive view: the board shows removed tasks instead of live ones. */
  showArchived: boolean;
  onShowArchived: (value: boolean) => void;
  archivedCount: number;
  /** How many finished results of the project the owner has not seen yet (viewing.ts). 0 — no counter. */
  unviewedCount?: number;
  onProjectSettings: () => void;
  /** Project branches dialog: base branch of new tasks, create, rename, delete. */
  onOpenBranches: () => void;
  onOpenWorktrees: () => void;
  onCreateTask: () => void;
  /** Whether tasks can be created at all: not for a project with a missing folder or an archived one. */
  canCreateTask?: boolean;
  /** A thin thread runs above the board while agents are actually working. */
  live: boolean;
}

/** Filter toggle button: the pressed state is shown by border and color, not left to guesswork. */
function FilterToggle({
  active,
  onClick,
  children,
  icon: Icon,
  tone,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  /** lucide icon or an orc glyph from brand/glyphs: both share one signature. */
  icon: LucideIcon | typeof Horn;
  tone?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] border px-2.5 text-[12px] font-medium transition-colors duration-100",
        focusRing,
        active
          ? cn("border-transparent bg-[color-mix(in_oklab,var(--ink)_10%,transparent)] text-[var(--ink)]", tone)
          : "border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]",
      )}
    >
      <Icon size={13} aria-hidden />
      {children}
    </button>
  );
}

/**
 * Splits an absolute path into a "head" and the last segment (folder name) so that
 * the path can be truncated in the middle: the beginning stays visible, and the final folder — the part
 * that matters most to recognize — is never cut off.
 */
function splitPathTail(path: string): [head: string, tail: string] {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return ["", path];
  return [path.slice(0, idx + 1), path.slice(idx + 1)];
}

/**
 * Board header: whose project this is, what we search for and what the board shows.
 *
 * Only what belongs to the selected project stays here. The orchestrator
 * state and the event feed moved to the bottom of the left column (see Sidebar): they are
 * shared by all projects, and the freed width went to search and filters.
 */
export const TopBar = forwardRef<HTMLInputElement, Props>(function TopBar(
  {
    project,
    view,
    onView,
    search,
    onSearch,
    attentionOnly,
    onAttentionOnly,
    attentionCount,
    showDone,
    onShowDone,
    showArchived,
    onShowArchived,
    archivedCount,
    unviewedCount = 0,
    onProjectSettings,
    onOpenBranches,
    onOpenWorktrees,
    onCreateTask,
    canCreateTask = true,
    live,
  },
  searchRef,
) {
  const { t } = useTranslation();
  return (
    <header className="relative flex h-12 shrink-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--surface)] px-3">
      {project ? (
        <div className="flex min-w-0 shrink items-center gap-2">
          <h1 className="min-w-0 truncate text-[14px] font-semibold tracking-tight text-[var(--ink)]">{project.name}</h1>
          {/* min-w-0 and a width limit are required: without them the repository path — the longest
              string in the header — does not shrink and takes space from search. We truncate in the middle:
              the head of the path shrinks with an ellipsis, while the final folder — what matters most
              to see — stays whole and is not the first to disappear. */}
          {(() => {
            const [head, tail] = splitPathTail(project.path);
            return (
              <span
                className={cn(
                  "hidden min-w-0 max-w-[14rem] items-center font-mono text-[11px] xl:flex",
                  project.path_ok ? "text-[var(--ink-faint)]" : "text-[var(--danger)] line-through",
                )}
                title={project.path_ok ? project.path : t("topBar.pathTitle", { path: project.path, error: project.path_error ?? "" })}
              >
                <span className="min-w-0 truncate">{head}</span>
                <span className="shrink-0">{tail}</span>
              </span>
            );
          })()}
          <Tip text={t("topBar.branchesTip")}>
            <IconButton icon={GitBranch} label={t("topBar.branchesTip")} size="sm" onClick={onOpenBranches} />
          </Tip>
          <Tip text={t("topBar.worktreesTip")}>
            <IconButton icon={FolderGit2} label={t("topBar.worktreesTip")} size="sm" onClick={onOpenWorktrees} />
          </Tip>
          <Tip text={t("topBar.settingsTip")}>
            <IconButton icon={Settings2} label={t("topBar.settingsTip")} size="sm" onClick={onProjectSettings} />
          </Tip>
        </div>
      ) : (
        <h1 className="text-[14px] font-semibold tracking-tight text-[var(--ink-muted)]">{t("topBar.projectNotChosen")}</h1>
      )}

      {/* Search and filters are the core of the header and the only thing that stretches:
          after the dispatcher and events moved to the column, there is finally width. */}
      {project && view === "board" && (
        <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
          <div className="relative min-w-[8rem] flex-1 lg:max-w-[28rem]">
            <Search size={13} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-faint)]" />
            <input
              ref={searchRef}
              type="search"
              aria-label={t("topBar.searchLabel")}
              placeholder={t("topBar.searchPlaceholder")}
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && search) {
                  e.preventDefault();
                  onSearch("");
                }
              }}
              className={cn(fieldBase, "h-8 w-full pl-7 pr-7 [&::-webkit-search-cancel-button]:hidden")}
            />
            {search && (
              <IconButton
                icon={X}
                label={t("topBar.clearSearch")}
                size="sm"
                className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2"
                onClick={() => onSearch("")}
              />
            )}
          </div>

          <FilterToggle
            active={attentionOnly}
            onClick={() => onAttentionOnly(!attentionOnly)}
            icon={Horn}
            tone="text-[var(--st-blocked)]"
          >
            {t("topBar.waitingForMe")}
            {attentionCount > 0 && <span className="tnum">{attentionCount}</span>}
          </FilterToggle>

          {/* The unseen counter sits on the "Done" button itself: when the column is hidden,
              this is the only place that shows new results have appeared. */}
          <FilterToggle
            active={showDone}
            onClick={() => onShowDone(!showDone)}
            icon={CheckCheck}
            title={unviewedCount > 0 ? t("viewing.count", { count: unviewedCount }) : undefined}
          >
            {t("topBar.doneFilter")}
            {unviewedCount > 0 && (
              <span className="tnum flex items-center gap-1 text-[var(--st-done)]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--st-done)]" />
                {unviewedCount}
              </span>
            )}
          </FilterToggle>

          {/* The archive is shown instead of the board, not next to it: the button switches the view,
              so it is pressed exactly when removed tasks are on screen. */}
          <FilterToggle active={showArchived} onClick={() => onShowArchived(!showArchived)} icon={Archive}>
            {t("topBar.archiveFilter")}
            {archivedCount > 0 && <span className="tnum">{archivedCount}</span>}
          </FilterToggle>
        </div>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* The view can always be switched, even when there is no project: the summary across all projects
            makes sense on an empty board too. */}
        <Segmented
          ariaLabel={t("topBar.viewLabel")}
          value={view}
          onChange={onView}
          options={[
            { value: "board", label: t("topBar.viewBoard") },
            { value: "dashboard", label: t("topBar.viewDashboard") },
            { value: "routines", label: t("topBar.viewRoutines") },
          ]}
        />

        {project && (
          <Tip
            text={
              canCreateTask
                ? t("topBar.newTaskTip")
                : project.archived_at
                  ? t("topBar.projectArchivedHint")
                  : t("topBar.pathUnavailableHint")
            }
          >
            {/* a disabled button does not catch mouse events, but the tooltip is needed exactly on it —
                hence the wrapper: it holds the hover instead of the button itself. */}
            <span className={cn("inline-flex", !canCreateTask && "cursor-not-allowed")}>
              <Button icon={Plus} variant="primary" disabled={!canCreateTask} onClick={onCreateTask}>
                {t("topBar.taskButton")}
              </Button>
            </span>
          </Tip>
        )}
      </div>

      {/* The thread under the header: while at least one agent is working, a phosphor segment runs along it.
          It is the only animation that plays on its own, and it means
          exactly one thing — something is happening right now. */}
      {live && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-px h-px overflow-hidden">
          <span className="orc-trace block h-px w-1/4 bg-gradient-to-r from-transparent via-[var(--live)] to-transparent" />
        </span>
      )}
    </header>
  );
});
