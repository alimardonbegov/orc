/**
 * A page dictionary string with `code` in backticks: commands, branches and files are drawn
 * in monospace, the rest as plain text. Neither markdown nor HTML is needed here —
 * the texts get translated, and the less markup in them, the less of it gets broken in translation.
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="rounded-[4px] bg-[color-mix(in_oklab,var(--ink)_7%,transparent)] px-1 py-px font-mono text-[0.9em] text-[var(--ink)]"
          >
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
