import { linkify } from "../lib/linkify";

/**
 * Plain text in which web addresses are clickable.
 *
 * Agents hand over links as text: to an artifact, a pull request, a page. A bare address is shown
 * short (the full one is in the tooltip and in the `href`), a markdown link keeps its label.
 * Links open in a new tab, because the board must not be replaced by the page.
 */
export function Linkified({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((c, i) =>
        c.kind === "text" ? (
          c.text
        ) : (
          <a
            key={i}
            href={c.href}
            title={c.href}
            target="_blank"
            rel="noreferrer noopener"
            className="break-all text-[var(--st-todo)] underline decoration-[color-mix(in_oklab,var(--st-todo)_40%,transparent)] underline-offset-2 hover:decoration-current"
          >
            {c.label}
          </a>
        ),
      )}
    </>
  );
}
