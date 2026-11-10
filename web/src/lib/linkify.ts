/**
 * Links inside plain text that an agent or a person wrote.
 *
 * Agents answer in text: a link to an artifact, a pull request or a page arrives as a bare URL or as
 * a markdown link `[label](url)`. This module cuts the text into chunks of text and links so the
 * view can make the links clickable and show them short. Only http and https are recognised: a
 * `javascript:` address must never become a link.
 */

export interface TextChunk {
  kind: "text";
  text: string;
}

export interface LinkChunk {
  kind: "link";
  /** The full address the link opens. */
  href: string;
  /** What is shown: the author's label for a markdown link, otherwise a shortened address. */
  label: string;
}

export type Chunk = TextChunk | LinkChunk;

/** A markdown link, an address in angle brackets, or a bare address, whichever comes first. */
const PATTERN = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s<>]+)>|https?:\/\/[^\s<>"'`*]+/g;

/** Punctuation that ends a sentence rather than an address. */
const TRAILING = /[.,;:!?'"»”]+$/;

/** The longest shown address before it gets cut in the middle. */
const MAX_LABEL = 44;

/** Closing bracket without its opening one belongs to the sentence: "(see https://a.b/c)". */
function trimUrl(raw: string): { url: string; rest: string } {
  let url = raw;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING, "");
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      while (url.endsWith(close) && count(url, close) > count(url, open)) url = url.slice(0, -1);
    }
    if (url === before) break;
  }
  return { url, rest: raw.slice(url.length) };
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function isHttp(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A short form of an address for display: no scheme, no `www.`, no trailing slash, and a long
 * remainder is cut in the middle so both the host and the tail (the id of an artifact, the number
 * of a pull request) stay visible.
 */
export function shortenUrl(href: string): string {
  let shown = href;
  try {
    const u = new URL(href);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    shown = u.host.replace(/^www\./, "") + path + u.search + u.hash;
  } catch {
    shown = href.replace(/^https?:\/\//, "");
  }
  if (shown.length <= MAX_LABEL) return shown;
  const tail = 14;
  return `${shown.slice(0, MAX_LABEL - tail - 1)}…${shown.slice(-tail)}`;
}

/** Text → alternating chunks of text and links in the order they appear. */
export function linkify(text: string): Chunk[] {
  const out: Chunk[] = [];
  let last = 0;
  const push = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev?.kind === "text") prev.text += t;
    else out.push({ kind: "text", text: t });
  };
  PATTERN.lastIndex = 0;
  for (let m = PATTERN.exec(text); m !== null; m = PATTERN.exec(text)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      // `[label](url)`: the author named the link, so the name is shown as written.
      if (isHttp(m[2])) out.push({ kind: "link", href: m[2], label: m[1] });
      else push(m[0]);
    } else if (m[3] !== undefined) {
      if (isHttp(m[3])) out.push({ kind: "link", href: m[3], label: shortenUrl(m[3]) });
      else push(m[0]);
    } else {
      const { url, rest } = trimUrl(m[0]);
      if (isHttp(url)) {
        out.push({ kind: "link", href: url, label: shortenUrl(url) });
        push(rest);
      } else {
        push(m[0]);
      }
    }
  }
  push(text.slice(last));
  return out;
}
