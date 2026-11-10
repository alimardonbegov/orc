import { afterEach, expect, it } from "vitest";
import { rawOffsetForView, visibleOffsetAt } from "./caret";

const IMG = "![shot](orc-image:7)";

it("in plain text the caret lands where the click was", () => {
  expect(rawOffsetForView("hello world", 0)).toBe(0);
  expect(rawOffsetForView("hello world", 5)).toBe(5);
  expect(rawOffsetForView("hello world", 11)).toBe(11);
});

it("past the visible text the caret goes to the end", () => {
  expect(rawOffsetForView("abc", 99)).toBe(3);
  expect(rawOffsetForView("", 0)).toBe(0);
});

it("text after an image is shifted by the whole marker, which the view does not show as text", () => {
  const raw = `before\n${IMG}\nafter`;
  // The view: "before", the caption "shot", then "after" (the newlines around the marker are cut)
  expect(rawOffsetForView(raw, 3)).toBe(3);
  const afterStart = raw.indexOf("after");
  expect(rawOffsetForView(raw, "before".length + "shot".length + 2)).toBe(afterStart + 2);
});

it("a bare address is shown short, but the caret after it is counted in the full address", () => {
  const raw = "see https://example.com/a/long/path now";
  // "see " (4) + label "example.com/a/long/path" + " now"
  expect(rawOffsetForView(raw, 4 + "example.com/a/long/path".length + 2)).toBe(raw.indexOf(" now") + 2);
  expect(rawOffsetForView(raw, 4)).toBe(4);
});

it("a markdown link counts its whole source, and a link in angle brackets its brackets", () => {
  const md = "a [the page](https://x.test/p) b";
  expect(rawOffsetForView(md, 1 + 1 + "the page".length + 1)).toBe(md.indexOf(" b") + 1);
  const angle = "a <https://x.test/p> b";
  expect(rawOffsetForView(angle, 2 + "x.test/p".length + 1)).toBe(angle.indexOf(" b") + 1);
});

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).caretRangeFromPoint;
  delete (document as unknown as Record<string, unknown>).caretPositionFromPoint;
  document.body.innerHTML = "";
});

it("the visible offset is the text between the start of the view and the point", () => {
  document.body.innerHTML = '<div id="v"><span>hello </span><span>world</span></div>';
  const root = document.getElementById("v")!;
  const node = root.lastChild!.firstChild!;
  (document as unknown as Record<string, unknown>).caretRangeFromPoint = () => ({ startContainer: node, startOffset: 3 });
  expect(visibleOffsetAt(root, 1, 1)).toBe(9);
});

it("the visible offset is unknown when the browser cannot place the point or it is outside the view", () => {
  document.body.innerHTML = '<div id="v">text</div><p id="o">other</p>';
  const root = document.getElementById("v")!;
  expect(visibleOffsetAt(root, 1, 1)).toBeNull();
  (document as unknown as Record<string, unknown>).caretPositionFromPoint = () => ({ offsetNode: document.getElementById("o")!.firstChild, offset: 1 });
  expect(visibleOffsetAt(root, 1, 1)).toBeNull();
});
