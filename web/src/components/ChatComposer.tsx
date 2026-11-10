import { useLayoutEffect, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";
import { focusRing } from "../ui/tokens";

const MAX_HEIGHT = 192;

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** The agent has a turn in progress. With nothing typed, the action button becomes Stop. */
  running?: boolean;
  onStop?: () => void;
  /** A send is in flight: the text stays put until the server has taken it. */
  submitting?: boolean;
  placeholder: string;
  error?: string | null;
  /** The bottom left of the card: who is being talked to and about what. */
  leading?: React.ReactNode;
  autoFocus?: boolean;
  disabled?: boolean;
}

/**
 * The message box of every chat: one card that lights up as a whole when it is typed into, grows with
 * the text, and has one round button in the corner. Enter sends, Shift+Enter adds a line, and the
 * button turns into Stop while the agent works on an empty box, so there is nowhere to look for it.
 */
export function ChatComposer({ value, onChange, onSubmit, running, onStop, submitting, placeholder, error, leading, autoFocus, disabled }: Props) {
  const { t } = useTranslation();
  const box = useRef<HTMLTextAreaElement>(null);
  const empty = !value.trim();
  const stop = !!running && empty && !!onStop;

  // The box is as tall as its text, up to a limit: a fixed one is either a keyhole or a wall
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !el.scrollHeight) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  return (
    <div className="shrink-0 px-3 pb-3 pt-1">
      {error && <p className="mb-1.5 text-[12px] text-[var(--danger)]">{error}</p>}
      <div
        // The whole card is the click target: the empty strip under the text should not be a dead zone
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            box.current?.focus();
          }
        }}
        className={cn(
          "flex flex-col rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--sunken)] transition-[border-color,box-shadow] duration-100",
          "hover:border-[var(--line-strong)] focus-within:border-[var(--focus)] focus-within:ring-2 focus-within:ring-[color-mix(in_oklab,var(--focus)_30%,transparent)]",
        )}
      >
        <textarea
          ref={box}
          aria-label={placeholder}
          rows={1}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!submitting) onSubmit();
            }
          }}
          className="max-h-48 min-h-[2.75rem] w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-[13px] leading-relaxed text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none disabled:opacity-50"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">{leading}</div>
          {stop ? (
            <button
              type="button"
              aria-label={t("chats.stop")}
              title={t("chats.stop")}
              onClick={onStop}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-ink)] transition-opacity hover:opacity-90",
                focusRing,
              )}
            >
              <Square size={11} fill="currentColor" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              aria-label={t("chats.send")}
              title={t("chats.send")}
              disabled={empty || submitting || disabled}
              onClick={onSubmit}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-ink)] transition-opacity hover:opacity-90",
                "disabled:cursor-default disabled:bg-[color-mix(in_oklab,var(--ink)_12%,transparent)] disabled:text-[var(--ink-faint)] disabled:hover:opacity-100",
                focusRing,
              )}
            >
              <ArrowUp size={15} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
