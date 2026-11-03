import { attachmentUrl, parseDescription } from "../attachments";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";

interface Props {
  text: string;
  className?: string;
  /** Compact view: in the conversation and the message queue an image must not take up half the
   * window. */
  compact?: boolean;
}

/**
 * Task text as its owner wrote it: images stand exactly where the marker is.
 *
 * Without this component the card would show a raw `![](orc-image:7)`, something the owner did not
 * write and which says nothing.
 */
export function DescriptionView({ text, className, compact = false }: Props) {
  const { t } = useTranslation();
  // Newlines around the marker are a trace of the editor setting it off from the text. On screen
  // the image itself provides the spacing, and a blank line on top turns into a hole. We cut only
  // those: inside the text we do not touch the owner's formatting.
  const segments = parseDescription(text)
    .map((s, i, all) => {
      if (s.kind !== "text") return s;
      let segmentText = s.text;
      if (all[i - 1]?.kind === "image") segmentText = segmentText.replace(/^\n{1,2}/, "");
      if (all[i + 1]?.kind === "image") segmentText = segmentText.replace(/\n{1,2}$/, "");
      return { ...s, text: segmentText };
    })
    .filter((s) => s.kind !== "text" || s.text !== "");
  if (segments.length === 0) return null;
  return (
    <div className={cn("text-[13px] leading-relaxed", className)}>
      {segments.map((s, i) =>
        s.kind === "text" ? (
          <span key={i} className="whitespace-pre-wrap">
            {s.text}
          </span>
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
