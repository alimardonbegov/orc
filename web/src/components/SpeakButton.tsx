import { useId, useSyncExternalStore } from "react";
import { Play, Square } from "lucide-react";
import { useTranslation } from "../i18n";
import { cn } from "../lib/cn";
import { detectSpeechLanguage, toSpeechChunks } from "../lib/speech";
import { speakingId, speechSupported, startSpeech, stopSpeech, subscribeSpeech } from "../lib/speechPlayer";

/**
 * "Listen" under an agent's long message: reads it aloud with the browser's voice.
 *
 * The text is prepared for speech only on the click (markup dropped, names split into words,
 * years and dates turned into phrases), so a long conversation does not pay for it. Hidden when
 * the browser has no speech synthesis.
 */
export function SpeakButton({ text, className }: { text: string; className?: string }) {
  const { t, language } = useTranslation();
  const id = useId();
  const playing = useSyncExternalStore(subscribeSpeech, () => speakingId() === id, () => false);
  if (!speechSupported()) return null;
  const label = playing ? t("chats.speakStop") : t("chats.speak");
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={playing}
      title={label}
      onClick={() => {
        if (playing) {
          stopSpeech();
          return;
        }
        const spoken = detectSpeechLanguage(text, language);
        startSpeech(id, toSpeechChunks(text, spoken), spoken);
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[11px] text-[var(--ink-faint)] transition-colors hover:bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] hover:text-[var(--ink)]",
        playing && "text-[var(--st-todo)]",
        className,
      )}
    >
      {playing ? <Square size={11} aria-hidden /> : <Play size={11} aria-hidden />}
      {label}
    </button>
  );
}
