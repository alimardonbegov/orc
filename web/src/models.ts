import type { TFunction } from "./i18n";

/**
 * A single list of Claude models for dropdowns (project and task).
 * Order = order in the list: the most common ones on top.
 * id goes into `claude --model <id>`, so these are exact identifiers, not aliases.
 * label is the model name, it is not translated (a proper name); hint is translated via t().
 */
export interface ModelOption {
  id: string;
  label: string;
  /** Short hint in parentheses: what this model is for. */
  hint: string;
}

const MODEL_IDS_LABELS: { id: string; label: string }[] = [
  { id: "claude-fable-5-2", label: "Fable 5.2" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

/** Identifiers in list order: models get their series colors on the dashboard by it (series.ts). */
export const MODEL_ORDER: readonly string[] = MODEL_IDS_LABELS.map((m) => m.id);

export function getModelOptions(t: TFunction): ModelOption[] {
  return MODEL_IDS_LABELS.map(({ id, label }) => ({ id, label, hint: t(`models.${id}`) }));
}

export const isKnownModel = (id: string) => MODEL_IDS_LABELS.some((m) => m.id === id);

/**
 * Model label for the interface: "Opus 5" for known ones, the id itself for hand-entered ones.
 * A transcript may name a model with a snapshot date ("claude-haiku-4-5-20251001") — it is the same
 * model as in the list, so the match is also looked up by prefix.
 */
export function modelLabel(id: string): string {
  const exact = MODEL_IDS_LABELS.find((m) => m.id === id);
  if (exact) return exact.label;
  const dated = MODEL_IDS_LABELS.find((m) => id.startsWith(`${m.id}-`) && /^\d{8}$/.test(id.slice(m.id.length + 1)));
  return dated?.label ?? id;
}

/**
 * Hidden models from the orc setting (settings.hidden_models — a JSON string).
 * A broken value is read as "nothing hidden": better to show too much than to lose the list.
 */
export function parseHiddenModels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

/**
 * What is hidden in project dropdowns: the project's own list, and if there is none (null) — the shared one from
 * orc settings. The own list replaces the shared one entirely rather than adding to it: this way in a single project
 * a model hidden everywhere can be brought back.
 */
export function effectiveHiddenModels(
  project: { hidden_models?: string[] | null } | null | undefined,
  appHidden: readonly string[],
): readonly string[] {
  return project?.hidden_models ?? appHidden;
}
