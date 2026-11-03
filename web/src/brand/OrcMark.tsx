import { cn } from "../lib/cn";
import { ORC_MARK_PATHS } from "./markPaths";

/**
 * The orc mark: an orc's head, a skull with ears, a mouth slit and two tusks growing from the lower
 * jaw. The geometry is shared across the whole brand (see docs/design/brand.md and
 * web/public/brand/*.svg): the silhouette is drawn in currentColor, so the mark sits on any
 * background and in both themes without separate versions.
 *
 * The only coloured part is the eyes. They glow phosphor --live exactly when the dispatcher is
 * alive: the same rule by which the dot in the header lights up (colour in the interface means
 * state, not decoration). A sleeping orc looks out with muted eyes in the silhouette colour.
 */

interface Props extends Omit<React.SVGProps<SVGSVGElement>, "children"> {
  /** Side of the square in pixels. The minimum at which the tusks stay readable is 16. */
  size?: number;
  /** Eyes glow: the dispatcher responds and is not paused. */
  awake?: boolean;
  /** Eyes pulse: at least one agent is working right now. Only meaningful together with awake. */
  working?: boolean;
  /** Label for the screen reader. Without it the mark is decorative and hidden from it. */
  title?: string;
}

export function OrcMark({ size = 20, awake = false, working = false, title, className, ...rest }: Props) {
  const p = ORC_MARK_PATHS;
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-awake={awake ? "true" : "false"}
      className={cn("shrink-0", className)}
      {...rest}
    >
      <path d={p.skull} />
      <path d={p.ears} />
      <path d={p.jaw} />
      <path d={p.tusks} />
      <path
        d={p.eyes}
        data-testid="orc-eyes"
        className={cn(
          "transition-[fill,opacity] duration-300",
          awake ? "fill-[var(--live)]" : "opacity-35",
          awake && working && "orc-eyes-pulse",
        )}
      />
    </svg>
  );
}
