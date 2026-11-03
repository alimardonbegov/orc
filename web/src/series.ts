import type { AnalyticsSplit } from "./types";
import { MODEL_ORDER } from "./models";

/**
 * Dashboard series colors: which hue a model, project or status gets in a bar stack.
 *
 * One rule: color follows the entity, not its place in the ranking. So a slot is
 * assigned by a fixed key order (models — by the list in models.ts, projects —
 * alphabetically), not by magnitude: if Sonnet overtook Opus over a week, both kept
 * their colors, and an eye that learned "blue is Opus" is not deceived. There are eight slots
 * (--cat-1 … --cat-8 in index.css, the palette is checked for color blindness); everything beyond
 * eight folds into a single gray "other" series — a ninth hue
 * can no longer be told apart, and it has no label anyway.
 *
 * Status is not a name but a state, and is colored with the same hues as the cards on the board.
 */

export const SERIES_SLOTS = 8;

/** Key of the folded tail: does not collide with model and project names. */
export const OTHER_KEY = "\u0000other";

export const STATUS_KEYS = ["done", "failed"] as const;

const STATUS_TONE: Record<string, string> = {
  done: "var(--st-done)",
  failed: "var(--st-failed)",
};

/** Breakdown keys in a stable order — the same one in which they get colors and stand in the legend. */
export function seriesOrder(split: AnalyticsSplit, keys: Iterable<string>): string[] {
  const unique = Array.from(new Set(keys));
  if (split === "by_status") {
    return STATUS_KEYS.filter((k) => unique.includes(k));
  }
  if (split === "by_model") {
    const rank = (k: string) => {
      const i = MODEL_ORDER.indexOf(k);
      return i === -1 ? MODEL_ORDER.length : i;
    };
    return unique.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }
  return unique.sort((a, b) => a.localeCompare(b));
}

/**
 * Colors for a set of keys. Returns both the series order and the color of each; keys beyond eight
 * slots are absent from `order` — their values must be added into OTHER_KEY (see foldSeries).
 */
export function seriesPalette(split: AnalyticsSplit, keys: Iterable<string>): { order: string[]; color: Map<string, string> } {
  const sorted = seriesOrder(split, keys);
  const color = new Map<string, string>();
  if (split === "by_status") {
    for (const key of sorted) color.set(key, STATUS_TONE[key] ?? "var(--ink-faint)");
    return { order: sorted, color };
  }
  const head = sorted.length > SERIES_SLOTS ? sorted.slice(0, SERIES_SLOTS - 1) : sorted;
  head.forEach((key, i) => color.set(key, `var(--cat-${i + 1})`));
  if (sorted.length > SERIES_SLOTS) {
    head.push(OTHER_KEY);
    color.set(OTHER_KEY, "var(--ink-faint)");
  }
  return { order: head, color };
}

/** Folds keys that did not make it into `order` into OTHER_KEY: values are summed. */
export function foldSeries<T>(cells: Record<string, T>, order: string[], sum: (a: T, b: T) => T): Record<string, T> {
  const known = new Set(order);
  const out: Record<string, T> = {};
  for (const [key, cell] of Object.entries(cells)) {
    const target = known.has(key) ? key : OTHER_KEY;
    out[target] = target in out ? sum(out[target], cell) : cell;
  }
  return out;
}
