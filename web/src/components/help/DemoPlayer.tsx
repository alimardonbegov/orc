import { useEffect, useState, type ReactNode } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useTranslation } from "../../i18n";
import { focusRing } from "../../ui/tokens";
import { cn } from "../../lib/cn";
import { RichText } from "./RichText";

interface Props {
  title: string;
  /** A caption for each frame; their count is the length of the demo. */
  captions: string[];
  /** The frame by step number. The scene itself holds no state — so it is easy to test. */
  children: (step: number) => ReactNode;
  /** How long one frame lasts, ms: the caption must have time to be read. */
  stepMs?: number;
  className?: string;
}

/**
 * Mini demo on the help pages: a scene assembled from the same colors and labels as
 * the interface, instead of a GIF. This way the demo is translated together with the page, follows the theme
 * and does not go stale when the screenshot is redesigned.
 *
 * It does not play on its own: animations in the dashboard respond to a person's action
 * (see "Motion" in index.css), so the demo starts on a button. The dots at the bottom are
 * a scrubber: any frame can be jumped to by hand and read without rushing.
 */
export function DemoPlayer({ title, captions, children, stepMs = 2200, className }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const last = captions.length - 1;
  const ended = !playing && step === last;

  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => {
      const next = Math.min(step + 1, last);
      setStep(next);
      // The last frame stays on screen, and the button becomes "Again"
      if (next === last) setPlaying(false);
    }, stepMs);
    return () => clearTimeout(id);
  }, [playing, step, last, stepMs]);

  const toggle = () => {
    if (playing) {
      setPlaying(false);
    } else {
      // A finished demo starts over, one stopped midway continues.
      if (step === last) setStep(0);
      setPlaying(true);
    }
  };

  const ToggleIcon = playing ? Pause : ended ? RotateCcw : Play;
  const toggleLabel = playing ? t("pages.demo.pause") : ended ? t("pages.demo.replay") : t("pages.demo.play");

  return (
    <figure
      aria-label={t("pages.demo.regionLabel", { title })}
      className={cn("overflow-hidden rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)]", className)}
    >
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-1.5">
        {/* Three window dots — the scene reads as an interface frame, not as a diagram */}
        <span aria-hidden className="flex gap-1">
          <span className="h-2 w-2 rounded-full bg-[var(--line-strong)]" />
          <span className="h-2 w-2 rounded-full bg-[var(--line-strong)]" />
          <span className="h-2 w-2 rounded-full bg-[var(--line-strong)]" />
        </span>
        <span className="truncate text-[11px] font-medium text-[var(--ink-muted)]">{title}</span>
      </div>

      <div className="relative bg-[var(--canvas)]" aria-hidden>
        {children(step)}
        {/* A big button over the first frame — until the demo has ever been started */}
        {!playing && step === 0 && (
          <button
            type="button"
            tabIndex={-1}
            onClick={toggle}
            className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_oklab,var(--canvas)_35%,transparent)] transition-colors hover:bg-[color-mix(in_oklab,var(--canvas)_20%,transparent)]"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-ink)] shadow-[var(--shadow-pop)]">
              <Play size={18} className="translate-x-px" />
            </span>
          </button>
        )}
      </div>

      <figcaption className="flex items-center gap-2.5 border-t border-[var(--line)] px-2 py-1.5">
        <button
          type="button"
          onClick={toggle}
          aria-label={toggleLabel}
          title={toggleLabel}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--ink-muted)] hover:bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] hover:text-[var(--ink)]",
            focusRing,
          )}
        >
          <ToggleIcon size={14} aria-hidden />
        </button>
        <p aria-live="polite" className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--ink)]">
          <RichText text={captions[step]} />
        </p>
        <span className="flex shrink-0 items-center gap-1">
          {captions.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={t("pages.demo.goToStep", { step: i + 1 })}
              aria-current={i === step ? "step" : undefined}
              onClick={() => {
                setPlaying(false);
                setStep(i);
              }}
              className={cn("flex h-5 w-3 items-center justify-center rounded-full", focusRing)}
            >
              <span
                className={cn(
                  "block h-1.5 rounded-full transition-all duration-200",
                  i === step ? "w-3 bg-[var(--ink)]" : "w-1.5 bg-[var(--line-strong)]",
                )}
              />
            </button>
          ))}
        </span>
        <span className="tnum hidden shrink-0 text-[11px] text-[var(--ink-faint)] sm:inline">
          {t("pages.demo.stepOf", { step: step + 1, total: captions.length })}
        </span>
      </figcaption>
    </figure>
  );
}
