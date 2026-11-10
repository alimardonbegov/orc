import { attachmentUrl, displaySegments } from "../attachments";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";
import { Linkified } from "./Linkified";
import { Markdown } from "./Markdown";

interface Props {
  text: string;
  className?: string;
  /** Compact view: in the conversation and the message queue an image must not take up half the
   * window. */
  compact?: boolean;
  /** Plain text instead of markdown. The click-to-edit view needs it: a click is mapped to a
   * place in the source text, which only works while the shown text is the source. */
  plain?: boolean;
}

/**
 * Task text as its owner wrote it: images stand exactly where the marker is.
 *
 * Without this component the card would show a raw `![](orc-image:7)`, something the owner did not
 * write and which says nothing.
 */
export function DescriptionView({ text, className, compact = false, plain = false }: Props) {
  const { t } = useTranslation();
  const segments = displaySegments(text);
  if (segments.length === 0) return null;
  return (
    <div className={cn("text-[13px] leading-relaxed", className)}>
      {segments.map((s, i) =>
        s.kind === "text" ? (
          plain ? (
            <span key={i} className="whitespace-pre-wrap">
              <Linkified text={s.text} />
            </span>
          ) : (
            <Markdown key={i} text={s.text} />
          )
        ) : (
          <figure key={i} className="my-1.5">
            {/* A link, not just an image: a small screenshot in the card is unreadable, and
               opening it at full size is one click. */}
            <a href={attachmentUrl(s.id)} target="_blank" rel="noreferrer">
              <img
                src={attachmentUrl(s.id)}
                alt={s.alt || t("descriptionView.imageAlt")}
                className={cn(
                  "max-w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--sunken)] object-contain",
                  compact ? "max-h-32" : "max-h-72",
                )}
              />
            </a>
            {s.alt && <figcaption className="mt-0.5 text-[11px] text-[var(--ink-faint)]">{s.alt}</figcaption>}
          </figure>
        ),
      )}
    </div>
  );
}
