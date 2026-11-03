import { Archive, ArchiveRestore, FolderSearch, Settings2 } from "lucide-react";
import type { Project } from "../types";
import { Button } from "../ui/Button";
import { useTranslation } from "../i18n";

interface Props {
  project: Project;
  /** Open the project settings: the path is edited there. */
  onOpenSettings: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  pending?: boolean;
}

/**
 * Strip above the board: this project cannot be worked with right now.
 *
 * There are exactly two causes, and both are fixed from here. The project folder was moved or
 * deleted behind the dashboard's back: then any task will run into a non-existent directory, and
 * one must either specify a new path or admit the project is no longer needed. Or the project is
 * already archived, and then the only sensible action is to restore it.
 *
 * Silently showing the board in both cases is not acceptable: the cards look workable, but the very
 * first attempt to start a task ends with a server refusal without an explanation of the reason.
 */
export function ProjectAlert({ project, onOpenSettings, onArchive, onUnarchive, pending }: Props) {
  const { t } = useTranslation();
  if (project.archived_at) {
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[var(--sunken)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">
        <Archive size={13} className="shrink-0" aria-hidden />
        <span className="min-w-0">
          {t("projectAlert.archivedBody")}
        </span>
        <Button variant="secondary" size="sm" icon={ArchiveRestore} loading={pending} className="ml-auto" onClick={onUnarchive}>
          {t("taskModal.unarchive")}
        </Button>
      </div>
    );
  }
  if (project.path_ok) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color-mix(in_oklab,var(--danger)_30%,var(--line))] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--danger)]">
      <FolderSearch size={13} className="shrink-0" aria-hidden />
      <span className="min-w-0">
        {t("projectAlert.pathUnavailable", { error: project.path_error ?? "" })}{" "}
        <span className="font-mono text-[11px]" title={project.path}>
          {project.path}
        </span>
        . {t("projectAlert.pathUnavailableSuffix")}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button variant="secondary" size="sm" icon={Settings2} onClick={onOpenSettings}>
          {t("projectAlert.changePath")}
        </Button>
        <Button variant="ghost" size="sm" icon={Archive} loading={pending} onClick={onArchive}>
          {t("taskModal.archive")}
        </Button>
      </span>
    </div>
  );
}
