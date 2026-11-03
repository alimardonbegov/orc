import { useEffect, useState } from "react";
import { api } from "../api";
import type { Settings } from "../types";
import type { Theme } from "../hooks/useUiState";
import { Button } from "../ui/Button";
import { Field, Input, Select, Textarea, Toggle } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { Segmented } from "../ui/Segmented";
import { OrcLogo } from "../brand/OrcLogo";
import { LANGUAGES, useTranslation } from "../i18n";
import { parseHiddenModels } from "../models";
import { ModelVisibility } from "./ModelVisibility";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  /** Settings saved: App re-reads what depends on them right away (hidden models). */
  onSaved?: (settings: Settings) => void;
}

/**
 * Global orc settings. The /api/settings endpoint used to exist, but the interface had no door to
 * it: changing the prompt template and the agent limit had to be done by a manual request.
 */
export function SettingsDialog({ open, onOpenChange, theme, onThemeChange, onSaved }: Props) {
  const { t, language, setLanguage } = useTranslation();
  const THEMES: { value: Theme; label: string }[] = [
    { value: "system", label: t("settingsDialog.themeSystem") },
    { value: "light", label: t("settingsDialog.themeLight") },
    { value: "dark", label: t("settingsDialog.themeDark") },
  ];
  const [loaded, setLoaded] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // We pull the settings on every open: they could have been changed by another instance of the
  // interface or by editing the settings file outside the UI.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .settings()
      .then((s) => {
        if (!alive) return;
        setLoaded(s);
        setDraft(s);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const dirty =
    loaded !== null && draft !== null && (Object.keys(loaded) as (keyof Settings)[]).some((k) => loaded[k] !== draft[k]);

  async function save() {
    if (!draft || !loaded) return;
    setError(null);
    setPending(true);
    try {
      // We send only what changed: the backend validates every field and rejects as a whole.
      const body: Partial<Settings> = {};
      for (const k of Object.keys(loaded) as (keyof Settings)[]) {
        if (loaded[k] !== draft[k]) body[k] = draft[k];
      }
      const saved = await api.patchSettings(body);
      setLoaded(saved);
      setDraft(saved);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      sticky={dirty || pending}
      title={t("settingsDialog.title")}
      subtitle={t("settingsDialog.subtitle")}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button variant="primary" loading={pending} disabled={!dirty} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && (
          <p className="rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--danger)]">
            {error}
          </p>
        )}

        <Field label={t("settingsDialog.appearance")}>
          <Segmented
            ariaLabel={t("settingsDialog.appearance")}
            value={theme}
            options={THEMES}
            onChange={(v) => onThemeChange(v as Theme)}
          />
        </Field>

        <Field label={t("settingsDialog.language")}>
          <Select aria-label={t("settingsDialog.language")} value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.nativeName}
              </option>
            ))}
          </Select>
        </Field>

        {draft === null ? (
          <p className="py-6 text-center text-[12px] text-[var(--ink-muted)]">{t("common.loading")}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("settingsDialog.maxWorkersLabel")} hint={t("settingsDialog.maxWorkersHint")}>
                <Input
                  type="number"
                  min={1}
                  value={draft.global_max_workers}
                  onChange={(e) => set("global_max_workers", e.target.value)}
                />
              </Field>
              <Field label={t("settingsDialog.pollIntervalLabel")} hint={t("settingsDialog.pollIntervalHint")}>
                <Input
                  type="number"
                  min={5}
                  value={draft.poll_interval_sec}
                  onChange={(e) => set("poll_interval_sec", e.target.value)}
                />
              </Field>
              <Field
                label={t("settingsDialog.verifyWorkersLabel")}
                hint={t("settingsDialog.verifyWorkersHint")}
              >
                <Input
                  type="number"
                  min={1}
                  value={draft.verify_workers}
                  onChange={(e) => set("verify_workers", e.target.value)}
                />
              </Field>
              <Field label={t("settingsDialog.eventsRetentionLabel")} hint={t("settingsDialog.eventsRetentionHint")}>
                <Input
                  type="number"
                  min={0}
                  value={draft.events_retention_days}
                  onChange={(e) => set("events_retention_days", e.target.value)}
                />
              </Field>
              <Field label={t("settingsDialog.attachmentsLabel")} hint={t("settingsDialog.attachmentsHint")}>
                <Input
                  type="number"
                  min={1}
                  value={draft.attachments_max_total_mb}
                  onChange={(e) => set("attachments_max_total_mb", e.target.value)}
                />
              </Field>
            </div>

            <Field label={t("settingsDialog.hiddenModelsLabel")} hint={t("settingsDialog.hiddenModelsHint")}>
              <ModelVisibility
                hidden={parseHiddenModels(draft.hidden_models)}
                onChange={(next) => set("hidden_models", JSON.stringify(next))}
              />
            </Field>

            <Field
              label={t("settingsDialog.promptTemplateLabel")}
              hint={t("settingsDialog.promptTemplateHint")}
            >
              <Textarea
                className="min-h-40 font-mono text-[12px]"
                value={draft.prompt_template}
                onChange={(e) => set("prompt_template", e.target.value)}
              />
            </Field>

            <Field
              label={t("settingsDialog.quotaPatternsLabel")}
              hint={t("settingsDialog.quotaPatternsHint")}
            >
              <Textarea
                className="min-h-24 font-mono text-[12px]"
                value={draft.quota_patterns}
                onChange={(e) => set("quota_patterns", e.target.value)}
              />
            </Field>

            {/* The backend stores the flag as the string "1"/"0" (see orc/api.py), while the
               person needs a toggle: we convert right here instead of smearing it across types. */}
            <Toggle
              checked={draft.conflict_autoresolve === "1"}
              onChange={(v) => set("conflict_autoresolve", v ? "1" : "0")}
              label={t("settingsDialog.conflictAutoresolveLabel")}
              hint={t("settingsDialog.conflictAutoresolveHint")}
            />

            {draft.conflict_autoresolve === "1" && (
              <Field
                label={t("settingsDialog.conflictPromptLabel")}
                hint={t("settingsDialog.conflictPromptHint")}
              >
                <Textarea
                  className="min-h-32 font-mono text-[12px]"
                  value={draft.conflict_prompt_template}
                  onChange={(e) => set("conflict_prompt_template", e.target.value)}
                />
              </Field>
            )}

            <Toggle
              checked={draft.worktree_autoclean === "1"}
              onChange={(v) => set("worktree_autoclean", v ? "1" : "0")}
              label={t("settingsDialog.worktreeAutocleanLabel")}
              hint={t("settingsDialog.worktreeAutocleanHint")}
            />

            {draft.worktree_autoclean === "1" && (
              <Field label={t("settingsDialog.worktreeRetentionLabel")} hint={t("settingsDialog.worktreeRetentionHint")}>
                <Input
                  type="number"
                  min={0}
                  className="w-32"
                  value={draft.worktree_retention_days}
                  onChange={(e) => set("worktree_retention_days", e.target.value)}
                />
              </Field>
            )}
          </>
        )}

        {/* Who we are: the mark, the name and the door to the brand book. The brand book is
           a static page served by the same server (web/public/brand/), so the link is a plain
           one. The path includes index.html: the server serves files, not directories (see
           orc/server.py). */}
        <div className="flex items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
          <OrcLogo size={22} awake tagline={t("settingsDialog.tagline")} />
          <a
            href="/brand/index.html"
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-[12px] text-[var(--ink-muted)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
          >
            {t("settingsDialog.brandBook")}
          </a>
        </div>
      </div>
    </Modal>
  );
}
