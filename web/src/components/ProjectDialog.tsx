import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, FilePlus2, FolderGit2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import type { ClaudeMdFile, ClaudeMdLocation, PermissionMode, Project, ProjectPathCheck } from "../types";
import { Button } from "../ui/Button";
import { Field, Input, Select, Textarea, Toggle } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { Confirm } from "../ui/Confirm";
import { AgentPicker } from "./AgentPicker";
import { EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";
import { ModelVisibility } from "./ModelVisibility";
import { CardSettingsEditor } from "./CardSettingsEditor";
import { cleanCardSettings, useAppCardSettings, type CardSettings } from "../cardSettings";
import { useAppHiddenModels } from "../hiddenModels";
import { effectiveHiddenModels } from "../models";
import { PermissionPicker } from "./PermissionPicker";
import { cn } from "../lib/cn";
import { useTranslation, type TFunction } from "../i18n";

/** Fields edited in the dialog. The path is editable after creation too: project folders get moved,
 * and without this field a moved project stays dead forever. */
interface Draft {
  name: string;
  path: string;
  default_model: string | null;
  default_effort: string | null;
  default_permission_mode: PermissionMode;
  /** Base branch for new tasks. "" means use the one checked out in the repository. */
  default_branch: string;
  verify_cmd: string;
  verify_timeout_sec: number;
  max_workers: number;
  push_enabled: boolean;
  /** Whether to track viewing of finished results (viewing.ts). */
  track_viewed: boolean;
  /** Own list of hidden models. null means as in orc settings. */
  hidden_models: string[] | null;
  /** The project's lead agent (orc/agents.py). */
  lead_agent_id: number | null;
  /** What this project's cards show and start with. null means as in orc settings. */
  card_settings: CardSettings | null;
}

const draftOf = (p: Project | null): Draft => ({
  name: p?.name ?? "",
  path: p?.path ?? "",
  default_model: p?.default_model ?? null,
  default_effort: p?.default_effort ?? null,
  default_permission_mode: p?.default_permission_mode ?? "auto",
  default_branch: p?.default_branch ?? "",
  verify_cmd: p?.verify_cmd ?? "",
  verify_timeout_sec: p?.verify_timeout_sec ?? 900,
  max_workers: p?.max_workers ?? 2,
  push_enabled: !!p?.push_enabled,
  // Viewing is on for a new project, as on the server (orc/db.py)
  track_viewed: p ? !!p.track_viewed : true,
  hidden_models: p?.hidden_models ?? null,
  lead_agent_id: p?.lead_agent_id ?? null,
  card_settings: p?.card_settings ?? null,
});

// The hidden-models list is an array: comparing by reference would always consider it changed
const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null means creating a new project. */
  project: Project | null;
  onSaved: (project: Project) => void;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t border-[var(--line)] pt-4 first:border-0 first:pt-0">
      <div>
        <h3 className="text-[13px] font-semibold text-[var(--ink)]">{title}</h3>
        {hint && <p className="mt-0.5 text-[11px] leading-snug text-[var(--ink-faint)]">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** Starter for a new CLAUDE.md: an empty file is useless, and with a skeleton it is immediately
 * clear what to write. */
function starter(t: TFunction): string {
  return t("projectDialog.claudeMdStarter");
}

function locationHint(t: TFunction, location: ClaudeMdLocation): string {
  return t(`projectDialog.locationHint.${location}`);
}

/**
 * One memory location: an editor if the file exists, and a "Create" button if it does not yet.
 *
 * The difference is fundamental: an empty input field cannot be told apart from an empty file,
 * while the button honestly says that the file is not in the repository and will appear only by an
 * explicit action.
 */
function MemoryFile({
  file,
  text,
  opened,
  onCreate,
  onChange,
}: {
  file: ClaudeMdFile;
  text: string;
  opened: boolean;
  onCreate: () => void;
  onChange: (text: string) => void;
}) {
  const { t } = useTranslation();
  if (file.error) {
    return (
      <div className="rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--danger)]">
        <span className="font-mono">{file.rel}</span>: {file.error}
      </div>
    );
  }
  if (!file.exists && !opened) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-dashed border-[var(--line)] px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate font-mono text-[12px] text-[var(--ink)]" title={file.path}>
            {file.rel}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--ink-faint)]">{t("projectDialog.fileMissing", { hint: locationHint(t, file.location) })}</p>
        </div>
        <Button variant="secondary" size="sm" icon={FilePlus2} onClick={onCreate} title={t("projectDialog.createFileTitle", { path: file.path })}>
          {t("projectDialog.createFile")}
        </Button>
      </div>
    );
  }
  return (
    <Field
      label={file.rel}
      hint={file.exists ? t("projectDialog.mdEditHint") : t("projectDialog.mdWillCreate", { path: file.path })}
    >
      <Textarea
        aria-label={file.rel}
        className="min-h-48 font-mono text-[12px]"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("projectDialog.mdPlaceholder")}
      />
    </Field>
  );
}

/**
 * Adding a project and its settings: one dialog with an explicit save button.
 *
 * Settings used to live in the sidebar footer, where only about 180 pixels were left for a field,
 * and were saved silently on focus loss: it was impossible to tell whether anything had been
 * written. Here it is the opposite: edits accumulate in a draft, the "Save" button is active only
 * when there is something to save, and the dialog does not close on an outside click while the
 * draft is dirty.
 */
export function ProjectDialog({ open, onOpenChange, project, onSaved }: Props) {
  const { t } = useTranslation();
  const creating = project === null;
  // key on the Modal content: when the project changes, the draft must start over, otherwise the
  // previous project's values would land in the new project's fields.
  const [draft, setDraft] = useState<Draft>(() => draftOf(project));
  const [loadedFor, setLoadedFor] = useState<number | null>(project?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // CLAUDE.md lives not in the database but as files in the repository: we read them separately
  // from the project card and keep side by side the read state (mdFiles), the edit (mdDrafts) and
  // the list of locations where the file does not exist yet but the person pressed "Create"
  // (mdOpen).
  const [mdFiles, setMdFiles] = useState<ClaudeMdFile[] | null>(null);
  const [mdDrafts, setMdDrafts] = useState<Record<string, string>>({});
  const [mdOpen, setMdOpen] = useState<Record<string, boolean>>({});
  const [mdError, setMdError] = useState<string | null>(null);
  // Branches live in git, not in the project card: we read them separately so that the base branch
  // is chosen from existing ones rather than typed by hand with typos.
  const [branches, setBranches] = useState<{ current: string; names: string[] } | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  // The "no repository at this path" fork: the server's answer about the new project's path. null
  // means there is no question; anything else opens a dialog with the choice "cancel / create git".
  const [pathCheck, setPathCheck] = useState<ProjectPathCheck | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // The dialog is long and scrolls, while the refusal is shown at the top: from the "Save" button
  // at the bottom it is simply not visible. So on a refusal we pull the message into view,
  // otherwise it looks as if the press did nothing.
  useEffect(() => {
    if (error !== null) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  if ((project?.id ?? null) !== loadedFor) {
    setLoadedFor(project?.id ?? null);
    setDraft(draftOf(project));
    setError(null);
    setMdFiles(null);
    setMdDrafts({});
    setMdOpen({});
    setMdError(null);
    setBranches(null);
    setPathCheck(null);
  }

  const projectId = project?.id ?? null;
  // We re-read on every open: the file could have been changed by an agent while the board was
  // running.
  useEffect(() => {
    if (!open || projectId === null) return;
    let alive = true;
    api
      .claudeMd(projectId)
      .then((memory) => {
        if (!alive) return;
        setMdFiles(memory.files);
        setMdDrafts(Object.fromEntries(memory.files.map((f) => [f.location, f.content])));
        setMdOpen({});
        setMdError(null);
      })
      .catch((e: unknown) => {
        if (alive) setMdError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [open, projectId]);

  useEffect(() => {
    if (!open || projectId === null) return;
    let alive = true;
    api
      .branches(projectId)
      .then((b) => alive && setBranches({ current: b.current, names: b.branches }))
      .catch(() => alive && setBranches(null));
    return () => {
      alive = false;
    };
  }, [open, projectId]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const base = draftOf(project);
  const fieldsDirty = (Object.keys(base) as (keyof Draft)[]).some((k) => !sameValue(base[k], draft[k]));
  const fieldsDirtyExceptPath = (Object.keys(base) as (keyof Draft)[]).some(
    (k) => k !== "path" && !sameValue(base[k], draft[k]),
  );
  const appHiddenModels = useAppHiddenModels();
  const appCardSettings = useAppCardSettings();
  const hiddenModels = effectiveHiddenModels(draft, appHiddenModels);
  // Both locations can be edited at once, so a list of changed files goes to saving, not a single
  // text. An unreadable file (error) never gets into this list.
  const mdChanged = (mdFiles ?? []).filter((f) => !f.error && (mdDrafts[f.location] ?? f.content) !== f.content);
  const dirty = fieldsDirty || mdChanged.length > 0;
  const valid = draft.name.trim() !== "" && draft.path.trim() !== "";

  const pathChanged = !creating && draft.path.trim() !== project.path;

  /** initGit is consent to create a repository in an empty place, obtained in the fork dialog. */
  async function save(opts: { initGit?: boolean } = {}) {
    setError(null);
    setPending(true);
    // Card after the move: if no PATCH is needed later, it is that one that must go up, not the one
    // that was opened (it still has the old path).
    let relocated: Project | null = null;
    try {
      // We parse the new project's path BEFORE creating it. The point is the distinction: "no
      // folder" and "git not initialised" are not a refusal but a fork, and the person may choose
      // "create". Previously this spot got a red "not a git repository" error, after which one
      // could only guess what to do with an empty folder.
      if (creating && !opts.initGit) {
        const check = await api.checkProjectPath(draft.path.trim());
        if (check.status !== "ok") {
          if (check.can_init) {
            setPathCheck(check);
            return;
          }
          setError(check.message ?? t("projectDialog.cannotCreateAtPath"));
          return;
        }
      }
      // The move goes first: it repairs task worktrees and rewrites their paths, and everything
      // else (CLAUDE.md, branches) must be read and written already at the new location.
      if (pathChanged) {
        const moved = await api.moveProject(project.id, draft.path.trim());
        relocated = moved.project;
        toast.success(
          moved.relinked > 0
            ? t("projectDialog.pathChangedRelinked", { count: moved.relinked })
            : t("projectDialog.pathChanged"),
        );
        // Warnings do not cancel the move, but they cannot be kept quiet: these are exactly the
        // cards that will end up without their branch or working copy at the new location.
        for (const warning of moved.warnings) toast.warning(warning);
      }
      // Files are written next: if there is a conflict here (someone edited CLAUDE.md behind the
      // dashboard's back), the project fields have not gone to the server yet, and the person sees
      // exactly one reason for the refusal.
      if (!creating) {
        for (const file of mdChanged) {
          const savedMd = await api.saveClaudeMd(project.id, {
            location: file.location,
            content: mdDrafts[file.location] ?? "",
            prev_sha: file.sha,
          });
          setMdFiles((files) => (files ?? []).map((f) => (f.location === savedMd.location ? savedMd : f)));
          setMdDrafts((d) => ({ ...d, [savedMd.location]: savedMd.content }));
          setMdOpen((o) => ({ ...o, [savedMd.location]: false }));
        }
      }
      // The path has already gone in a separate request, so it is not in the PATCH: we compare the
      // rest.
      if (!creating && !fieldsDirtyExceptPath) {
        onSaved(relocated ?? project);
        onOpenChange(false);
        return;
      }
      const saved = creating
        ? await api.addProject({
            name: draft.name.trim(),
            path: draft.path.trim(),
            default_model: draft.default_model,
            default_effort: draft.default_effort,
            default_permission_mode: draft.default_permission_mode,
            default_branch: draft.default_branch || null,
            verify_cmd: draft.verify_cmd.trim() || null,
            verify_timeout_sec: draft.verify_timeout_sec,
            max_workers: draft.max_workers,
            push_enabled: draft.push_enabled ? 1 : 0,
            track_viewed: draft.track_viewed ? 1 : 0,
            hidden_models: draft.hidden_models,
            init_git: opts.initGit === true,
          })
        : await api.patchProject(project.id, {
            name: draft.name.trim(),
            default_model: draft.default_model,
            default_effort: draft.default_effort,
            default_permission_mode: draft.default_permission_mode,
            default_branch: draft.default_branch || null,
            verify_cmd: draft.verify_cmd.trim() || null,
            verify_timeout_sec: draft.verify_timeout_sec,
            max_workers: draft.max_workers,
            push_enabled: draft.push_enabled ? 1 : 0,
            track_viewed: draft.track_viewed ? 1 : 0,
            hidden_models: draft.hidden_models,
            lead_agent_id: draft.lead_agent_id,
            card_settings: cleanCardSettings(draft.card_settings),
          });
      onSaved(saved);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  function toggleArchive() {
    if (creating) return;
    setError(null);
    setArchivePending(true);
    const call = project.archived_at ? api.unarchiveProject(project.id) : api.archiveProject(project.id);
    call
      .then((saved) => {
        toast.success(saved.archived_at ? t("projectDialog.archivedToast") : t("projectDialog.unarchivedToast"));
        onSaved(saved);
        onOpenChange(false);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setArchivePending(false));
  }

  return (
    <>
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      sticky={dirty || pending}
      title={creating ? t("projectDialog.newProjectTitle") : t("projectDialog.settingsTitle", { name: project.name })}
      subtitle={
        !creating && (
          <span className="flex items-center gap-1.5 font-mono text-[11px]" title={project.path}>
            <FolderGit2 size={11} aria-hidden />
            <span className="truncate">{project.path}</span>
          </span>
        )
      }
      footer={
        <>
          {/* Archive is the left edge of the footer: it is neither cancel nor save but the
             third outcome of a conversation with the project, which is most often reached from
             the "folder missing" banner. */}
          {!creating && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto"
              icon={project.archived_at ? ArchiveRestore : Archive}
              loading={archivePending}
              onClick={toggleArchive}
            >
              {project.archived_at ? t("taskModal.unarchive") : t("projectDialog.moveToArchive")}
            </Button>
          )}
          {dirty && <span className={cn("text-[11px] text-[var(--ink-faint)]", creating && "mr-auto")}>{t("projectDialog.unsavedChanges")}</span>}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!valid || (!creating && !dirty)}
            onClick={() => void save()}
          >
            {creating ? t("app.addProject") : pathChanged ? t("projectDialog.changePathAndSave") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && (
          <p ref={errorRef} className="rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--danger)]">
            {error}
          </p>
        )}

        <Section title={t("projectDialog.repoSection")}>
          <Field label={t("projectDialog.nameLabel")}>
            <Input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder={t("projectDialog.namePlaceholder")} autoFocus={creating} />
          </Field>
          <Field
            label={t("projectDialog.pathLabel")}
            hint={creating ? t("projectDialog.pathHintCreating") : t("projectDialog.pathHintExisting")}
          >
            <Input
              className="font-mono"
              value={draft.path}
              onChange={(e) => set("path", e.target.value)}
              placeholder="/Users/me/Projects/my-repo"
            />
          </Field>
          {/* The move touches more than the card: git repairs the working copies' links of
             tasks, and their paths are rewritten to the new root. We say so BEFORE the button
             is pressed, so the warning is here, not as a pop-up over the dialog. */}
          {pathChanged && (
            <p className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--sunken)] px-3 py-2 text-[11px] leading-snug text-[var(--ink-muted)]">
              {t("projectDialog.pathChangeWarning")}
            </p>
          )}
          {/* The banner is exactly where it gets fixed: under the path field, not only above
             the board. */}
          {!creating && !project.path_ok && !pathChanged && (
            <p className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[12px] leading-snug text-[var(--danger)]">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
              <span>{t("projectDialog.pathUnavailableWarning", { error: project.path_error ?? "" })}</span>
            </p>
          )}
        </Section>

        {/* Tasks run on agents, and an agent carries its own model, effort and permission mode, so
           this section is only about who leads the project and how many agents work at once. */}
        <Section title={t("projectDialog.runSection")} hint={t("projectDialog.runSectionHint")}>
          {/* A new project has no id for an internal agent yet, so a lead is appointed afterwards. */}
          {!creating && (
            <AgentPicker
              projectId={project.id}
              value={draft.lead_agent_id}
              onChange={(next) => set("lead_agent_id", next)}
              label={t("agents.lead.label")}
              noneLabel={t("agents.lead.none")}
              hint={t("agents.lead.hint")}
            />
          )}
          <Field label={t("projectDialog.maxWorkersLabel")} hint={t("projectDialog.maxWorkersHint")}>
            <Input
              type="number"
              min={1}
              max={5}
              value={draft.max_workers}
              onChange={(e) => set("max_workers", Math.min(5, Math.max(1, Number(e.target.value) || 1)))}
            />
          </Field>
        </Section>

        {/* The project's own model, effort and mode are only a fallback for an agent that sets none
           of its own, so they are tucked away and absent when creating: a new project starts with
           "as Claude Code decides" and the agents choose. The details element keeps its fields
           mounted when closed, so the draft and the dirty check see them either way. */}
        {!creating && (
          <details className="group rounded-[var(--radius-sm)] border border-[var(--line)]">
            <summary className="cursor-pointer select-none px-3 py-2.5">
              <span className="text-[13px] font-semibold text-[var(--ink)]">{t("projectDialog.fallbackSection")}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-[var(--ink-faint)]">{t("projectDialog.fallbackSectionHint")}</span>
            </summary>
            <div className="space-y-5 border-t border-[var(--line)] p-3">
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <ModelPicker
                    value={draft.default_model}
                    defaultLabel={t("projectDialog.claudeDecides")}
                    hidden={hiddenModels}
                    onChange={(m) => set("default_model", m)}
                  />
                  <EffortPicker
                    value={draft.default_effort}
                    defaultLabel={t("projectDialog.claudeDecides")}
                    onChange={(v) => set("default_effort", v)}
                  />
                </div>
                {/* There is no empty option here: a project always has a mode. */}
                <PermissionPicker
                  value={draft.default_permission_mode}
                  onChange={(next) => set("default_permission_mode", next ?? "auto")}
                />
              </div>
              {/* Own model visibility: off means the project shows the same as configured in orc.
                 Turning it on copies the shared list as a starting point. */}
              <Section title={t("projectDialog.modelsSection")} hint={t("projectDialog.modelsSectionHint")}>
                <Toggle
                  checked={draft.hidden_models !== null}
                  onChange={(on) => set("hidden_models", on ? [...appHiddenModels] : null)}
                  label={t("projectDialog.ownModelListLabel")}
                  hint={t("projectDialog.ownModelListHint")}
                />
                <ModelVisibility
                  hidden={hiddenModels}
                  disabled={draft.hidden_models === null}
                  onChange={(next) => set("hidden_models", next)}
                />
              </Section>
            </div>
          </details>
        )}

        {/* Only for a project that exists: a default agent may be internal to it. Off means the cards
           follow orc; turning it on copies the shared settings as a starting point, as with the models. */}
        {project && (
          <Section title={t("card.settings.heading")} hint={t("card.settings.headingHint")}>
            <Toggle
              checked={draft.card_settings !== null}
              onChange={(on) => set("card_settings", on ? { ...appCardSettings } : null)}
              label={t("card.settings.ownLabel")}
              hint={t("card.settings.ownHint")}
            />
            <CardSettingsEditor
              projectId={project.id}
              disabled={draft.card_settings === null}
              value={draft.card_settings ?? appCardSettings}
              onChange={(next) => set("card_settings", next)}
            />
          </Section>
        )}

        {/* The base branch answers "where does work come from and go to": each new task's
           worktree is branched from it and the merge goes into it. Creating, renaming and
           deleting branches is in a separate dialog (the branch button in the header). */}
        {!creating && (
          <Section
            title={t("projectDialog.baseBranchSection")}
            hint={t("projectDialog.baseBranchSectionHint")}
          >
            <Field label={t("projectDialog.baseBranchFieldLabel")}>
              <Select
                aria-label={t("projectDialog.baseBranchFieldLabel")}
                className="font-mono"
                value={draft.default_branch}
                onChange={(e) => set("default_branch", e.target.value)}
              >
                <option value="">
                  {branches ? t("projectDialog.currentRepoBranchWithName", { current: branches.current }) : t("projectDialog.currentRepoBranch")}
                </option>
                {/* The branch could have been deleted behind the dashboard's back: we show
                   the saved value as is, otherwise the select would silently switch to the
                   first option and wipe the setting. */}
                {draft.default_branch && !(branches?.names ?? []).includes(draft.default_branch) && (
                  <option value={draft.default_branch}>{t("taskForm.branchGone", { branch: draft.default_branch })}</option>
                )}
                {(branches?.names ?? []).map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            </Field>
          </Section>
        )}

        <Section title={t("projectDialog.verifySection")} hint={t("projectDialog.verifySectionHint")}>
          <Field label={t("projectDialog.verifyCommandLabel")}>
            <Input
              className="font-mono"
              value={draft.verify_cmd}
              onChange={(e) => set("verify_cmd", e.target.value)}
              placeholder="make test"
            />
          </Field>
          <Field label={t("projectDialog.verifyTimeoutLabel")}>
            <Input
              type="number"
              min={10}
              value={draft.verify_timeout_sec}
              onChange={(e) => set("verify_timeout_sec", Math.max(10, Number(e.target.value) || 900))}
            />
          </Field>
        </Section>

        <Section title={t("projectDialog.afterMergeSection")}>
          <Toggle
            checked={draft.push_enabled}
            onChange={(v) => set("push_enabled", v)}
            label={t("projectDialog.pushEnabledLabel")}
            hint={t("projectDialog.pushEnabledHint")}
          />
          <Toggle
            checked={draft.track_viewed}
            onChange={(v) => set("track_viewed", v)}
            label={t("viewing.settingLabel")}
            hint={t("viewing.settingHint")}
          />
        </Section>

        {/* CLAUDE.md is edited right here because it is the main lever of influence on all
           of a project's agents: every session reads it, both in the main copy and in task
           worktrees. There are two locations (the root and .claude/), Claude Code reads both,
           so we show both. */}
        {!creating && (
          <Section
            title={t("projectDialog.memorySection")}
            hint={t("projectDialog.memorySectionHint")}
          >
            {mdError ? (
              <p className="rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--danger)]">
                {mdError}
              </p>
            ) : mdFiles === null ? (
              <p className="py-4 text-center text-[12px] text-[var(--ink-muted)]">{t("projectDialog.readingClaudeMd")}</p>
            ) : (
              mdFiles.map((file) => (
                <MemoryFile
                  key={file.location}
                  file={file}
                  text={mdDrafts[file.location] ?? file.content}
                  opened={!!mdOpen[file.location]}
                  onCreate={() => {
                    setMdOpen((o) => ({ ...o, [file.location]: true }));
                    setMdDrafts((d) => ({ ...d, [file.location]: d[file.location] || starter(t) }));
                  }}
                  onChange={(text) => setMdDrafts((d) => ({ ...d, [file.location]: text }))}
                />
              ))
            )}
          </Section>
        )}
      </div>

    </Modal>

    {/* A fork instead of a refusal: there is no repository at the given path, but one can be
       created right from here. A separate dialog, not an error line, because it is a choice
       with consequences: a folder and a git repository will appear on disk. */}
    <Confirm
      open={pathCheck !== null}
      title={pathCheck?.status === "no_git" ? t("projectDialog.noGitTitle") : t("projectDialog.noFolderTitle")}
      confirmLabel={pathCheck?.status === "no_git" ? t("projectDialog.initGitConfirm") : t("projectDialog.createFolderConfirm")}
      confirmVariant="primary"
      onCancel={() => setPathCheck(null)}
      onConfirm={() => {
        setPathCheck(null);
        void save({ initGit: true });
      }}
    >
      <p>
        {pathCheck?.status === "no_git"
          ? t("projectDialog.noGitBody", { path: pathCheck?.path ?? "" })
          : t("projectDialog.noFolderBody", { path: pathCheck?.path ?? "" })}
      </p>
      <p className="text-[var(--ink-muted)]">
        {t("projectDialog.gitExplain", {
          action: pathCheck?.status === "no_git" ? t("projectDialog.willRunGitInit") : t("projectDialog.willCreateAndInit"),
        })}
      </p>
    </Confirm>
    </>
  );
}
