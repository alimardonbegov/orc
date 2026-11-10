import type { Language } from "../i18n/language";

/**
 * Turns an agent's markdown message into text that sounds right when a speech synthesizer reads
 * it aloud.
 *
 * Reading the raw markdown is useless: the voice pronounces "asterisk asterisk", every backtick,
 * a hyphen between two years as "minus" and a file path letter by letter. Here the text is
 * rewritten the way a person would read it out: markup is dropped, identifiers are split into
 * words, ranges and dates become phrases, paths shrink to the file name, code blocks are
 * skipped. The result is a list of short chunks with the pause that should follow each one:
 * a synthesizer cuts off a long utterance, and the pauses at line breaks, paragraphs and
 * headings are what keeps the reading from running together.
 *
 * Nothing here touches the browser, so the whole module is covered by plain unit tests.
 */

/** One piece to say and how long to stay silent after it, in milliseconds. */
export interface SpeechChunk {
  text: string;
  pauseAfter: number;
}

interface Words {
  from: string;
  to: string;
  minus: string;
  dot: string;
  about: string;
  number: string;
  and: string;
  arrow: string;
  hash: string;
  code: string;
}

/** The words the text is rewritten with, per language of the *spoken* text. */
const WORDS: Record<Language, Words> = {
  en: { from: "from", to: "to", minus: "minus", dot: "dot", about: "about", number: "number", and: "and", arrow: "to", hash: "commit hash", code: "Code block skipped." },
  es: { from: "de", to: "a", minus: "menos", dot: "punto", about: "alrededor de", number: "número", and: "y", arrow: "a", hash: "hash de commit", code: "Bloque de código omitido." },
  fr: { from: "de", to: "à", minus: "moins", dot: "point", about: "environ", number: "numéro", and: "et", arrow: "vers", hash: "hash de commit", code: "Bloc de code ignoré." },
  de: { from: "von", to: "bis", minus: "minus", dot: "Punkt", about: "ungefähr", number: "Nummer", and: "und", arrow: "zu", hash: "Commit-Hash", code: "Codeblock übersprungen." },
  pt: { from: "de", to: "a", minus: "menos", dot: "ponto", about: "cerca de", number: "número", and: "e", arrow: "para", hash: "hash de commit", code: "Bloco de código omitido." },
  ru: { from: "с", to: "по", minus: "минус", dot: "точка", about: "около", number: "номер", and: "и", arrow: "в", hash: "хеш коммита", code: "Блок кода пропущен." },
};

/** BCP 47 tags for choosing a voice. */
export const SPEECH_LOCALES: Record<Language, string> = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  pt: "pt-BR",
  ru: "ru-RU",
};

/** Pauses after a line, a paragraph and a heading. */
const PAUSE_LINE = 250;
const PAUSE_PARAGRAPH = 600;
const PAUSE_HEADING = 700;

/** A longer utterance risks being cut off by the browser's synthesizer. */
const MAX_CHUNK = 220;

/**
 * The language to read the message in. Cyrillic letters decide it for Russian; otherwise the
 * interface language is used, except that a Russian interface with Latin text means English.
 */
export function detectSpeechLanguage(text: string, ui: Language): Language {
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cyrillic > latin) return "ru";
  if (ui === "ru") return "en";
  return ui;
}

// Private-use characters mark a spot where an already-spoken piece is put back, so later
// rules do not rewrite it a second time.
const OPEN = "";
const CLOSE = "";
const PLACEHOLDER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

const FILE_EXT = "py|ts|tsx|js|jsx|mjs|json|md|yml|yaml|toml|css|html|sh|txt|lock|ini|cfg|sql|go|rs|java|rb|php|swift|kt|c|h|cpp";

/** `camelCase`, `snake_case` and `kebab-case` as separate words. */
function splitIdentifier(token: string): string {
  return token
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

/** What is inside backticks, as it is read: a name, a file, a path or a short command. */
function speakCode(code: string, w: Words): string {
  const raw = code.trim();
  if (!raw) return "";
  const word = (token: string): string => {
    let t = token;
    if (t.includes("/")) {
      // A path is too long to listen to; the last part says what the file is.
      const parts = t.split("/").filter(Boolean);
      t = parts[parts.length - 1] ?? "";
    }
    t = t.replace(/^-+/, "").replace(/->|=>/g, ` ${w.arrow} `).replace(/[(){}[\];,"'`<>=!?:*+|&\\]+/g, " ");
    if (/^\d+(\.\d+)*$/.test(t.trim())) return t.trim();
    return t
      .split(".")
      .map((p) => splitIdentifier(p))
      .filter(Boolean)
      .join(` ${w.dot} `)
      .replace(/\s+/g, " ")
      .trim();
  };
  return raw.split(/\s+/).map(word).filter(Boolean).join(" ");
}

function formatIsoDate(y: number, m: number, d: number, language: Language): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  try {
    return new Intl.DateTimeFormat(SPEECH_LOCALES[language], { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
  } catch {
    return null;
  }
}

/** Rules for everything that is not code: numbers, dates, ranges, symbols. */
function speakProse(input: string, language: Language): string {
  const w = WORDS[language];
  let s = input;

  // Names of models: "claude-sonnet-5-5" is "Claude Sonnet 5.5", not five minus five.
  s = s.replace(/\b(claude)[- ](opus|sonnet|haiku|fable)[- ](\d+)(?:[-.](\d+))?\b/gi, (_m, brand: string, tier: string, major: string, minor?: string) => {
    const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();
    return `${cap(brand)} ${cap(tier)} ${major}${minor ? `.${minor}` : ""}`;
  });

  // A calendar date is said in words in the reader's language.
  s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => formatIsoDate(+y, +mo, +d, language) ?? m);

  // A period of years or of the day: "from 2020 to 2023", not "2020 minus 2023".
  // A preposition in front ("in 2020-2023", "в 2020-2023") would double the "from".
  s = s.replace(
    /(?:(?<![\p{L}])(?:in|during|from|over|в|за|с|de|en|von|im|durante)\s+)?\b(1\d{3}|2\d{3})\s*[–—-]\s*(1\d{3}|2\d{3})\b/giu,
    (_m, a: string, b: string) => `${w.from} ${a} ${w.to} ${b}`,
  );
  s = s.replace(/\b(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})\b/g, (_m, a: string, b: string) => `${w.from} ${a} ${w.to} ${b}`);

  // A range of numbers. A bare hyphen counts only when nothing else is glued to it, so that
  // phone numbers, ids and "1-2-3" are left alone.
  s = s.replace(/(?<![\w.\-/])(\d+(?:[.,]\d+)?)\s*[–—]\s*(\d+(?:[.,]\d+)?)(?![\w.\-/])/g, (_m, a: string, b: string) => `${a} ${w.to} ${b}`);
  s = s.replace(/(?<![\w.\-/:])(\d+(?:[.,]\d+)?)-(\d+(?:[.,]\d+)?)(?![\w.\-/:])/g, (_m, a: string, b: string) => `${a} ${w.to} ${b}`);

  // A sign in front of a number is a minus; a leading tilde or ≈ means "about".
  s = s.replace(/(^|[\s(])[-−–](?=\d)/g, (_m, pre: string) => `${pre}${w.minus} `);
  s = s.replace(/(^|[\s(])[~≈](?=\s?\d)/g, (_m, pre: string) => `${pre}${w.about} `);

  // "#1103" is a number of a card or a pull request.
  s = s.replace(/(^|[\s(])#(\d+)\b/g, (_m, pre: string, n: string) => `${pre}${w.number} ${n}`);

  // Versions: 3.12.1 is read with dots, otherwise the voice makes a date or a sum of it.
  s = s.replace(/\bv?(\d+(?:\.\d+){2,})\b/g, (_m, v: string) => v.split(".").join(` ${w.dot} `));

  // A commit hash is not worth reading character by character.
  s = s.replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g, w.hash);

  // Paths and file names written without backticks.
  s = s.replace(/(?:\.{0,2}\/|~\/)?(?:[\w.@-]+\/)+[\w.@-]*[\w@-]/g, (m) => {
    const parts = m.split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    const pathLike = parts.length >= 3 || /^(\.{1,2}|~)?\//.test(m) || new RegExp(`\\.(${FILE_EXT})$`, "i").test(last);
    return pathLike ? last : m;
  });
  s = s.replace(new RegExp(`\\b([\\w-]+)\\.(${FILE_EXT})\\b`, "gi"), (_m, name: string, ext: string) => `${splitIdentifier(name)} ${w.dot} ${ext}`);

  // snake_case words in prose.
  s = s.replace(/\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/g, (m) => m.replace(/_/g, " "));

  // Symbols that carry meaning.
  s = s.replace(/\s(?:->|=>|→)\s/g, ` ${w.arrow} `);
  s = s.replace(/\s&\s/g, ` ${w.and} `);
  s = s.replace(/\//g, " ");

  // Markup and punctuation that must not be pronounced; apostrophes inside words stay.
  s = s
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/(?<![\p{L}\d])['’‘]|['’‘](?![\p{L}\d])/gu, "")
    .replace(/["“”„«»]/g, "")
    .replace(/[*_#`~|<>[\]{}^\\=]/g, " ");

  return s.replace(/[ \t]+/g, " ").trim();
}

/** One line of markdown without its structure marks, with inline code and links read out. */
function speakLine(line: string, language: Language): string {
  const w = WORDS[language];
  const saved: string[] = [];
  const keep = (spoken: string): string => {
    saved.push(spoken);
    return `${OPEN}${saved.length - 1}${CLOSE}`;
  };

  let s = line;
  // Inline code first: what is inside is read by its own rules and hidden from the rest.
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => keep(speakCode(code, w)));
  // Pictures say their description; links say their text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => alt);
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, (_m, text: string) => text);
  // A bare address: the site is enough, the rest of the string is noise.
  s = s.replace(/<?\bhttps?:\/\/([^\s/)>]+)[^\s)>]*>?/gi, (_m, host: string) =>
    keep(host.replace(/^www\./i, "").split(".").join(` ${w.dot} `)),
  );
  s = s.replace(/\*\*|__|~~/g, "").replace(/(^|\s)\*(?=\S)|(?<=\S)\*(?=\s|$|[.,;:!?])/g, "$1");

  s = speakProse(s, language);
  return s.replace(PLACEHOLDER, (_m, i: string) => saved[Number(i)] ?? "").replace(/\s+/g, " ").trim();
}

function endSentence(s: string): string {
  return /[.!?…:;,]$/.test(s) ? s : `${s}.`;
}

interface Block {
  text: string;
  pauseAfter: number;
}

/** Splits a long block at sentence ends, then at commas and spaces, to fit the synthesizer. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const out: string[] = [];
  let current = "";
  const push = (piece: string) => {
    if (current && current.length + 1 + piece.length > MAX_CHUNK) {
      out.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  };
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    if (sentence.length <= MAX_CHUNK) {
      push(sentence);
      continue;
    }
    for (const part of sentence.split(/(?<=[,;:])\s+/)) {
      if (part.length <= MAX_CHUNK) {
        push(part);
        continue;
      }
      let rest = part;
      while (rest.length > MAX_CHUNK) {
        const cut = rest.lastIndexOf(" ", MAX_CHUNK);
        const at = cut > 0 ? cut : MAX_CHUNK;
        push(rest.slice(0, at));
        rest = rest.slice(at).trim();
      }
      if (rest) push(rest);
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * The message as a list of pieces to say. `language` is the language of the spoken text (see
 * `detectSpeechLanguage`).
 */
export function toSpeechChunks(markdown: string, language: Language): SpeechChunk[] {
  const w = WORDS[language];
  const blocks: Block[] = [];
  const add = (text: string, pauseAfter: number) => {
    if (text) blocks.push({ text, pauseAfter });
  };
  const endParagraph = () => {
    const last = blocks[blocks.length - 1];
    if (last) last.pauseAfter = Math.max(last.pauseAfter, PAUSE_PARAGRAPH);
  };

  let fence: string | null = null;
  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMark = /^\s*(```+|~~~+)/.exec(rawLine);
    if (fence !== null) {
      if (fenceMark && fenceMark[1]!.startsWith(fence[0]!) && fenceMark[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark[1]!;
      add(w.code, PAUSE_PARAGRAPH);
      continue;
    }

    const line = rawLine.trim();
    if (!line) {
      endParagraph();
      continue;
    }
    if (/^([-*_]\s*){3,}$/.test(line)) {
      endParagraph();
      continue;
    }
    // The line under a table's header: |---|:---:|
    if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes("-") && line.includes("|")) continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      add(endSentence(speakLine(heading[1]!.replace(/\s#+$/, ""), language)), PAUSE_HEADING);
      continue;
    }
    if (line.includes("|") && /^\|.*\|$|.+\s\|\s.+/.test(line)) {
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => speakLine(c, language)).filter(Boolean);
      add(endSentence(cells.join(", ")), PAUSE_LINE);
      continue;
    }

    const body = line
      .replace(/^>+\s?/, "")
      .replace(/^([-*+]|\d+[.)])\s+/, "")
      .replace(/^\[[ xX]\]\s+/, "");
    add(endSentence(speakLine(body, language)), PAUSE_LINE);
  }

  const chunks: SpeechChunk[] = [];
  for (const block of blocks) {
    const pieces = splitLong(block.text).filter((p) => /[\p{L}\d]/u.test(p));
    pieces.forEach((text, i) => chunks.push({ text, pauseAfter: i === pieces.length - 1 ? block.pauseAfter : 0 }));
  }
  return chunks;
}
