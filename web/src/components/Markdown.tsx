import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/cn";
import { shortenUrl } from "../lib/linkify";

/**
 * Markdown as agents write it: headings, lists, tables, code, bold, links.
 *
 * Raw HTML in the text is not interpreted (react-markdown shows it as text), and only http(s),
 * mailto and relative addresses become links, so an agent's message cannot inject markup or a
 * `javascript:` link. Single line breaks stay line breaks, as they did in plain text.
 */

const inlineCode =
  "rounded-[4px] bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] px-1 py-px font-mono text-[0.9em]";

const components: Components = {
  a({ href, children }) {
    const text = typeof children === "string" ? children : null;
    // A bare address is shown short; the full one stays in `href` and the tooltip.
    const label = text !== null && text === href ? shortenUrl(href ?? "") : children;
    return (
      <a
        href={href}
        title={href}
        target="_blank"
        rel="noreferrer noopener"
        className="break-words text-[var(--st-todo)] underline decoration-[color-mix(in_oklab,var(--st-todo)_40%,transparent)] underline-offset-2 hover:decoration-current"
      >
        {label}
      </a>
    );
  },
  p: (p) => <p className="my-1.5 first:mt-0 last:mb-0" {...strip(p)} />,
  h1: (p) => <h3 className="mb-1 mt-3 text-[15px] font-semibold first:mt-0" {...strip(p)} />,
  h2: (p) => <h3 className="mb-1 mt-3 text-[14px] font-semibold first:mt-0" {...strip(p)} />,
  h3: (p) => <h4 className="mb-1 mt-2.5 text-[13px] font-semibold first:mt-0" {...strip(p)} />,
  h4: (p) => <h4 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0" {...strip(p)} />,
  h5: (p) => <h5 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0" {...strip(p)} />,
  h6: (p) => <h6 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0" {...strip(p)} />,
  ul: (p) => <ul className="my-1.5 list-disc space-y-0.5 pl-5" {...strip(p)} />,
  ol: (p) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5" {...strip(p)} />,
  li: (p) => <li className="pl-0.5" {...strip(p)} />,
  blockquote: (p) => (
    <blockquote className="my-1.5 border-l-2 border-[var(--line-strong)] pl-3 text-[var(--ink-muted)]" {...strip(p)} />
  ),
  hr: () => <hr className="my-3 border-[var(--line)]" />,
  pre: (p) => (
    <pre
      className="my-2 overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--sunken)] p-2.5 font-mono text-[12px] leading-snug [&>code]:bg-transparent [&>code]:p-0"
      {...strip(p)}
    />
  ),
  code: ({ className, children }) => <code className={cn(inlineCode, className)}>{children}</code>,
  table: (p) => (
    <div className="my-2 max-w-full overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--line)]">
      <table className="w-full border-collapse text-[12px]" {...strip(p)} />
    </div>
  ),
  th: (p) => (
    <th className="border-b border-[var(--line)] bg-[var(--sunken)] px-2.5 py-1 text-left font-semibold" {...strip(p)} />
  ),
  td: (p) => <td className="border-t border-[var(--line)] px-2.5 py-1 align-top" {...strip(p)} />,
  img: ({ src, alt }) => (
    <img src={src} alt={alt ?? ""} loading="lazy" className="my-1.5 max-h-72 max-w-full rounded-[var(--radius-sm)]" />
  ),
};

/** react-markdown passes its syntax-tree `node` to every renderer; it must not reach the DOM. */
function strip<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const { node: _node, ...rest } = props;
  return rest;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("min-w-0 break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
