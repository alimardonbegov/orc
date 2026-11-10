import { SPEECH_LOCALES, type SpeechChunk } from "./speech";
import type { Language } from "../i18n/language";

/**
 * Plays prepared chunks through the browser's speech synthesizer, one message at a time.
 *
 * The voice is the browser's own: nothing is sent anywhere and nothing is paid for. Chunks go
 * one after another with the pause that `toSpeechChunks` asked for. Starting another message
 * stops the current one.
 */

type Listener = () => void;

let activeId: string | null = null;
let token = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<Listener>();

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function subscribeSpeech(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function speakingId(): string | null {
  return activeId;
}

function notify() {
  for (const l of listeners) l();
}

/** The most natural installed voice of the language: neural and enhanced ones first. */
export function pickVoice(voices: SpeechSynthesisVoice[], language: Language): SpeechSynthesisVoice | null {
  const locale = SPEECH_LOCALES[language];
  const matching = voices.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(language));
  if (matching.length === 0) return null;
  const score = (v: SpeechSynthesisVoice) =>
    (/natural|neural|premium|enhanced|google/i.test(v.name) ? 4 : 0) +
    (v.lang.replace("_", "-").toLowerCase() === locale.toLowerCase() ? 2 : 0) +
    (v.localService ? 1 : 0);
  return [...matching].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export function stopSpeech(): void {
  token += 1;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (speechSupported()) window.speechSynthesis.cancel();
  if (activeId !== null) {
    activeId = null;
    notify();
  }
}

export function startSpeech(id: string, chunks: SpeechChunk[], language: Language): void {
  if (!speechSupported() || chunks.length === 0) return;
  stopSpeech();
  const mine = token;
  activeId = id;
  notify();
  const synth = window.speechSynthesis;
  const voice = pickVoice(synth.getVoices(), language);

  const next = (i: number) => {
    if (mine !== token) return;
    const chunk = chunks[i];
    if (!chunk) {
      stopSpeech();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(chunk.text);
    utterance.lang = SPEECH_LOCALES[language];
    if (voice) utterance.voice = voice;
    const advance = () => {
      if (mine !== token) return;
      if (chunk.pauseAfter > 0 && i + 1 < chunks.length) timer = setTimeout(() => next(i + 1), chunk.pauseAfter);
      else next(i + 1);
    };
    utterance.onend = advance;
    // A cancelled utterance reports an error too; only that case is ours to ignore.
    utterance.onerror = (e) => {
      if (mine !== token) return;
      if (e.error === "canceled" || e.error === "interrupted") return;
      stopSpeech();
    };
    synth.speak(utterance);
  };
  next(0);
}
