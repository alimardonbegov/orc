import { cn } from "../lib/cn";

/**
 * Classes shared by all interactive elements. Kept apart from components
 * so that files in ui/ export only components (otherwise fast refresh breaks).
 */

/** Focus ring. Neutral-bright: color in the interface is taken by task statuses. */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--canvas)]";

/** Shared input "box": height equal to the md-size button, so that rows of controls align. */
export const fieldBase = cn(
  "w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--sunken)] px-2.5 text-[13px] text-[var(--ink)]",
  "placeholder:text-[var(--ink-faint)] transition-[border-color,background-color] duration-100",
  "hover:border-[var(--line-strong)] disabled:opacity-50",
  "focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--focus)_35%,transparent)]",
);

/**
 * The text metrics that the field and its mirror must share, character for character: if they differ,
 * the mirror wraps the lines differently and the field is a line too short or too tall.
 */
export const textBox = "border px-2.5 py-1.5 text-[13px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap";

/** Pulls a `textBox` out by its border and padding (1 + 10px), so that its text lines up with the text around it. */
export const textBoxBleed = "-mx-[11px]";
