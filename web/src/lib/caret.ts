/**
 * Where the caret should land in the text field after a click on the same text drawn as a view.
 *
 * The view and the field show one string differently: an image marker is a picture, a link is a short
 * label. So the click is carried over in two steps: how many visible characters precede the click
 * (`visibleOffsetAt`), then which place of the raw text that is (`rawOffsetForView`). It is best effort:
 * on anything unexpected the caret simply goes to the end.
 */
import { displaySegments } from "../attachments";
import { linkify } from "./linkify";

/** How many characters of the view's text precede the point, or null when the browser cannot tell. */
export function visibleOffsetAt(root: HTMLElement, x: number, y: number): number | null {
  let node: Node | null = null;
  let offset = 0;
  if (typeof document.caretPositionFromPoint === "function") {
    const pos = document.caretPositionFromPoint(x, y);
    node = pos?.offsetNode ?? null;
    offset = pos?.offset ?? 0;
  } else if (typeof document.caretRangeFromPoint === "function") {
    const range = document.caretRangeFromPoint(x, y);
    node = range?.startContainer ?? null;
    offset = range?.startOffset ?? 0;
  }
  if (!node || !root.contains(node)) return null;
  const before = document.createRange();
  before.setStart(root, 0);
  before.setEnd(node, offset);
  return before.toString().length;
}

/** The raw length of a link chunk: `[label](url)`, `<url>` or the bare address. */
function rawLinkLength(seg: string, at: number, href: string, label: string): number {
  const markdown = `[${label}](${href})`;
  if (seg.startsWith(markdown, at)) return markdown.length;
  if (seg[at] === "<") return href.length + 2;
  return href.length;
}

/** The place in the raw text for a caret that stands after `visible` characters of the view's text. */
export function rawOffsetForView(raw: string, visible: number): number {
  let seen = 0;
  for (const s of displaySegments(raw)) {
    if (s.kind === "image") {
      // Only the caption is text on screen; a caret in or after the picture goes after its marker.
      seen += s.alt.length;
      if (visible <= seen) return s.end;
      continue;
    }
    let at = 0;
    for (const chunk of linkify(s.text)) {
      if (chunk.kind === "text") {
        if (visible <= seen + chunk.text.length) return s.start + at + (visible - seen);
        seen += chunk.text.length;
        at += chunk.text.length;
      } else {
        const rawLength = rawLinkLength(s.text, at, chunk.href, chunk.label);
        if (visible <= seen + chunk.label.length) return s.start + at + (visible === seen ? 0 : rawLength);
        seen += chunk.label.length;
        at += rawLength;
      }
    }
  }
  return raw.length;
}
