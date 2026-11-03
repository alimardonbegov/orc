/**
 * Images inside the task description text.
 *
 * An image lives in the description as a marker `![caption](orc-image:7)`, an ordinary substring.
 * So its place in the text is its place in the specification: there is no separate attachment list
 * that could drift out of sync with the text. The same parsing is needed by the editor (insertion)
 * and the viewer (rendering).
 */
import type { Attachment } from "./types";
import type { TFunction } from "./i18n";

/** A global copy is needed for split/exec; for a one-off check we create our own. */
const MARKER = /!\[([^\]\n]*)\]\(orc-image:(\d+)\)/g;

export const ACCEPT_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_BYTES = 10 * 1024 * 1024;

export interface TextSegment {
  kind: "text";
  text: string;
}

export interface ImageSegment {
  kind: "image";
  id: number;
  alt: string;
}

export type Segment = TextSegment | ImageSegment;

/** Marker for insertion into the text. Characters that break parsing are stripped from the caption,
 * as in orc/attachments.py. */
export function imageMarker(id: number, caption = ""): string {
  const safe = caption.replace(/[[\]()\n]/g, " ").trim();
  return `![${safe}](orc-image:${id})`;
}

export function attachmentUrl(id: number): string {
  return `/api/attachments/${id}`;
}

/** Text → alternating chunks of text and images in the order they appear. */
export function parseDescription(text: string): Segment[] {
  const out: Segment[] = [];
  if (!text) return out;
  let last = 0;
  MARKER.lastIndex = 0;
  for (let m = MARKER.exec(text); m !== null; m = MARKER.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "image", id: Number(m[2]), alt: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export function countImages(text: string): number {
  return parseDescription(text).filter((s) => s.kind === "image").length;
}

/**
 * Insert a marker at the cursor position. Returns the new text and where to put the cursor. The
 * marker is always set off by newlines: otherwise, inserted mid-word, it would merge with the text
 * and become hard to spot.
 */
export function insertMarker(text: string, at: number, marker: string): { text: string; caret: number } {
  const pos = Math.max(0, Math.min(at, text.length));
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const tail = after === "" || after.startsWith("\n") ? "\n" : "\n";
  const inserted = `${lead}${marker}${tail}`;
  return { text: before + inserted + after, caret: pos + inserted.length };
}

/** File → base64 without the `data:` prefix: this is what POST /api/attachments expects. */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("couldn't read the file"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/** Checks before sending: the same as on the server, but without a network round trip. */
export function checkImage(t: TFunction, file: File): string | null {
  const name = file.name || t("attachments.file");
  if (!ACCEPT_MIME.includes(file.type)) return t("attachments.needsImage", { name });
  if (file.size > MAX_BYTES) return t("attachments.tooBig", { name, mb: MAX_BYTES / (1024 * 1024) });
  return null;
}

/** Images from a paste or drag-and-drop event. */
export function imagesFrom(source: DataTransfer | null | undefined): File[] {
  if (!source) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(source.items ?? [])) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) fromItems.push(file);
    }
  }
  const files = fromItems.length > 0 ? fromItems : Array.from(source.files ?? []);
  return files.filter((f) => f.type.startsWith("image/"));
}

export type Uploader = (body: { filename: string; mime: string; data: string }) => Promise<Attachment>;
