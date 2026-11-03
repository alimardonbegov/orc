import { initials } from "../lib/initials";
import { cn } from "../lib/cn";

interface Props {
  /** null means a dispatcher's own event, not tied to a project. */
  name: string | null;
  /** Show the full name next to the monogram: where there is room for it. */
  full?: boolean;
  className?: string;
}

/**
 * Project label: the same monogram as in the collapsed sidebar.
 *
 * Deliberately without its own colour: colour in the interface means exactly one thing, task state
 * (see the palette in index.css). Multicoloured project tags would compete with statuses and with
 * the event level. Two letters are enough to tell projects apart: they stand in the same place in
 * every row, and the eye catches the shape, not the colour.
 */
export function ProjectTag({ name, full, className }: Props) {
  // An event without a project comes from the orchestrator itself, and its label is the same
  // monogram that stands as the mark in the sidebar corner: "orc".
  const label = name ?? "orc";
  return (
    <span
      title={label}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-[5px] bg-[var(--sunken)] py-0.5 pl-1 pr-1.5 text-[11px] text-[var(--ink-muted)]",
        !full && "pr-1",
        className,
      )}
    >
      <span className="font-mono text-[10px] font-semibold tracking-tight text-[var(--ink-muted)]">
        {name ? initials(name) : "orc"}
      </span>
      {full && name && <span className="truncate">{label}</span>}
    </span>
  );
}
