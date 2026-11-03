import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_LANGUAGE, isLanguage, type Language } from "./language";
import { en, type Dictionary } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { de } from "./de";
import { pt } from "./pt";
import { ru } from "./ru";

const DICTIONARIES: Record<Language, Dictionary> = { en, es, fr, de, pt, ru };

// Version in the key: an incompatible edit of the language set will not pick up a stale foreign value.
const KEY = "orc.language.v1";

function readStored(): Language {
  try {
    const raw = localStorage.getItem(KEY);
    return isLanguage(raw) ? raw : DEFAULT_LANGUAGE;
  } catch {
    // Private mode, storage denied — the interface must open even with the default.
    return DEFAULT_LANGUAGE;
  }
}

function writeStored(language: Language): void {
  try {
    localStorage.setItem(KEY, language);
  } catch {
    // Out of space or storage denied — silently work without saving.
  }
}

/** Gets a value by the path `a.b.c` from a nested dictionary. */
function lookup(dict: Dictionary, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in acc) return (acc as Record<string, unknown>)[key];
    return undefined;
  }, dict);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: TFunction;
}

function translate(dict: Dictionary, key: string, vars?: Record<string, string | number>): string {
  const value = lookup(dict, key) ?? lookup(en, key);
  return typeof value === "string" ? interpolate(value, vars) : key;
}

/** t() in English without context/React — for unit tests of pure functions (see analytics.test.ts). */
export const defaultT: TFunction = (key, vars) => translate(en, key, vars);

// The default value is English without persistence: components rendered in tests
// without a LanguageProvider (there are many in the project and wrapping each is pointless) get
// a working t() instead of crashing on mount.
const LanguageContext = createContext<LanguageContextValue>({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
  t: (key, vars) => translate(en, key, vars),
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readStored);

  // lang on <html> — so screen readers and browser hints (auto-translation,
  // spell checking) know the page's real language rather than guessing from the text.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = (next: Language) => {
    setLanguageState(next);
    writeStored(next);
  };

  const t = useMemo<TFunction>(() => {
    const dict = DICTIONARIES[language];
    // The key may be missing in an incomplete dictionary — fall back to English
    // so that the interface shows text, not a bare key path.
    return (key, vars) => translate(dict, key, vars);
  }, [language]);

  const value = useMemo<LanguageContextValue>(() => ({ language, setLanguage, t }), [language, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useTranslation(): LanguageContextValue {
  return useContext(LanguageContext);
}
