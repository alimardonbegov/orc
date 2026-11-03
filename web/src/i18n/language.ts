/** Interface languages. English is the default for new users and private mode. */
export const LANGUAGES = [
  { code: "en", nativeName: "English" },
  { code: "es", nativeName: "Español" },
  { code: "fr", nativeName: "Français" },
  { code: "de", nativeName: "Deutsch" },
  { code: "pt", nativeName: "Português" },
  { code: "ru", nativeName: "Русский" },
] as const;

export type Language = (typeof LANGUAGES)[number]["code"];

export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && LANGUAGES.some((l) => l.code === value);
}
