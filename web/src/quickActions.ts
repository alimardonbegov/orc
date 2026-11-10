import { api } from "./api";
import type { ComposerMode } from "./activity";
import type { CardSettings } from "./cardSettings";
import type { ActivityNow } from "./types";
import type { TFunction } from "./i18n";

/** A canned message for the agent: shown on the card, and under "/" in the composer. */
export interface QuickAction {
  id: string;
  title: string;
  prompt: string;
}

/**
 * The set a fresh orc starts with, until the owner edits it. The prompts are English because the agent
 * reads them; only the titles follow the interface language (card.quickActions.defaults.<id>).
 */
const BUILT_IN: ReadonlyArray<{ id: string; prompt: string }> = [
  { id: "review", prompt: "Review your changes on this branch: look for bugs, missed edge cases and anything out of scope. Fix what you find and tell me what changed." },
  { id: "tests", prompt: "Write tests for the behaviour you changed, run them, and fix what they reveal." },
  { id: "summary", prompt: "Summarize what you have done so far, what is left, and anything you are unsure about." },
  { id: "simplify", prompt: "Look at your changes again and simplify them: remove duplication and dead code, without changing behaviour." },
];

/** What the card offers: the stored list (project, else orc), or the built-in set when none was ever saved. */
export function resolveQuickActions(settings: CardSettings, t: TFunction): QuickAction[] {
  if (settings.quick_actions) return settings.quick_actions;
  return BUILT_IN.map((a) => ({ id: a.id, title: t(`card.quickActions.defaults.${a.id}`), prompt: a.prompt }));
}

/**
 * How a quick action reaches the agent, by the state of the card: the same table as the composer's primary
 * send. A live session gets a message, a finished card goes to rework, a stopped session continues. Where
 * the agent cannot be reached (not started, verifying, a failed card without a session, an archive) the
 * answer is null and the action is disabled.
 */
export function quickActionSender(mode: ComposerMode | null, now: Pick<ActivityNow, "has_session"> | null, taskId: number): ((text: string) => Promise<unknown>) | null {
  switch (mode) {
    case "working":
    case "waiting_reply":
      return (text) => api.addComment(taskId, text, "answer");
    case "done":
      return (text) => api.addComment(taskId, text, "rework");
    case "failed":
      return now?.has_session ? (text) => api.resume(taskId, text) : null;
    default:
      return null;
  }
}

/** The text after a leading "/" while the draft is still a single word; null when the draft is not a command. */
export function slashQuery(draft: string): string | null {
  const match = /^\/(\S*)$/.exec(draft);
  return match ? match[1].toLowerCase() : null;
}

/** Actions whose title or id contains the typed text, in the order of the list. */
export function filterQuickActions(actions: readonly QuickAction[], query: string): QuickAction[] {
  if (!query) return [...actions];
  return actions.filter((a) => a.title.toLowerCase().includes(query) || a.id.toLowerCase().includes(query));
}

/** A new id for an action added in the editor: not used by any other. */
export function newActionId(actions: readonly QuickAction[]): string {
  const used = new Set(actions.map((a) => a.id));
  let n = actions.length + 1;
  while (used.has(`action-${n}`)) n += 1;
  return `action-${n}`;
}
