import { cn } from "../lib/cn";

/**
 * Orc glyphs: a few icons in the lucide language (24 grid, stroke 2, round caps) that lucide does
 * not draw but the brand needs. Each carries meaning rather than decorating: horn is a call to the
 * human, campfire is the warband resting, standard is a project, axe is work, tusk is the mark
 * itself in miniature. Functional status icons stay lucide: they are seen more often and must be
 * familiar.
 */

interface GlyphProps extends Omit<React.SVGProps<SVGSVGElement>, "children"> {
  size?: number;
}

function Glyph({ size = 16, className, children, ...rest }: GlyphProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("shrink-0", className)}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** War horn: a task calls the human. */
export function Horn(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4 17c0-6 5-11 12-12" />
      <path d="M4 17c2 1 4 0 5-2 2-3 4-5 8-6" />
      <path d="M16 5l1 4" />
      <path d="M4 17l-1 3" />
      <path d="M20 3l2 2" />
      <path d="M21 8l2-1" />
    </Glyph>
  );
}

/** Campfire: agents are free, the warband is resting. */
export function Campfire(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3c2 3 5 5 5 9a5 5 0 0 1-10 0c0-2.5 1.5-3.5 2-6 1 1 1.5 2 2.5 3 .5-2 .5-4 .5-6z" />
      <path d="M5 21l14-4" />
      <path d="M19 21L5 17" />
    </Glyph>
  );
}

/** Standard: a project, the banner the warband marches under. */
export function Banner(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M6 22V3" />
      <path d="M6 4h12l-3 4 3 4H6" />
      <path d="M4 22h4" />
    </Glyph>
  );
}

/** Axe: work that is going on right now. */
export function Axe(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4 20L13 11" />
      <path d="M12 6l3-3c4 1 7 4 8 8l-3 3c-2-3-5-6-8-8z" />
      <path d="M12 6l2 2" />
    </Glyph>
  );
}

/** Tusk: the orc mark in a single stroke. */
export function Tusk(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M7 21c-2-8 1-15 11-18-2 8-5 14-9 18z" />
      <path d="M6 21h5" />
    </Glyph>
  );
}
