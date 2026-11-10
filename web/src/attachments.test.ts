import { describe, expect, it } from "vitest";
import { countImages, displaySegments, imageMarker, imagesToUpload, insertMarker, parseDescription } from "./attachments";

describe("image markers", () => {
  it("the caption is cleaned of characters that break parsing", () => {
    expect(imageMarker(7, "shot [button] (left)")).toBe("![shot  button   left](orc-image:7)");
  });

  it("text without images stays a single chunk", () => {
    expect(parseDescription("just text")).toEqual([{ kind: "text", text: "just text" }]);
    expect(parseDescription("")).toEqual([]);
  });

  it("an image splits the text exactly at its position", () => {
    expect(parseDescription(`before ${imageMarker(3, "header")} after`)).toEqual([
      { kind: "text", text: "before " },
      { kind: "image", id: 3, alt: "header" },
      { kind: "text", text: " after" },
    ]);
  });

  it("the order of images is preserved", () => {
    const text = `${imageMarker(5)}\ntext\n${imageMarker(2)}`;
    expect(parseDescription(text).filter((s) => s.kind === "image").map((s) => s.id)).toEqual([5, 2]);
    expect(countImages(text)).toBe(2);
  });
});

describe("insertion at the cursor position", () => {
  it("the marker lands where the cursor was and is set off by line breaks", () => {
    const { text, caret } = insertMarker("textabove|textbelow", 9, "![](orc-image:1)");
    expect(text).toBe("textabove\n![](orc-image:1)\n|textbelow");
    expect(text.slice(caret)).toBe("|textbelow");
  });

  it("in an empty field no extra line break appears at the top", () => {
    expect(insertMarker("", 0, "![](orc-image:1)").text).toBe("![](orc-image:1)\n");
  });

  it("a position outside the text does not break the insertion", () => {
    expect(insertMarker("abc", 999, "![](orc-image:1)").text).toBe("abc\n![](orc-image:1)\n");
  });
});

describe("displaySegments", () => {
  it("cuts the newlines that set a marker off from the text and keeps where each piece starts", () => {
    const raw = "before\n![a](orc-image:3)\nafter";
    const segs = displaySegments(raw);
    expect(segs).toEqual([
      { kind: "text", text: "before", start: 0 },
      { kind: "image", id: 3, alt: "a", start: 7, end: 24 },
      { kind: "text", text: "after", start: 25 },
    ]);
    expect(raw.slice(segs[2].kind === "text" ? segs[2].start : 0)).toBe("after");
  });

  it("leaves the text between newlines alone when no image is near", () => {
    expect(displaySegments("a\n\nb\n")).toEqual([{ kind: "text", text: "a\n\nb\n", start: 0 }]);
  });
});

describe("imagesToUpload", () => {
  const png = (name = "image.png") => new File([new Uint8Array([1])], name, { type: "image/png" });
  const source = (text: string, files: File[]) =>
    ({ items: files.map((f) => ({ kind: "file", getAsFile: () => f })), files, getData: () => text }) as unknown as DataTransfer;

  it("takes a lone screenshot", () => {
    expect(imagesToUpload(source("", [png()]))).toHaveLength(1);
  });
  it("leaves the paste to the browser when text comes with a picture", () => {
    expect(imagesToUpload(source("a1\tb1", [png()]))).toHaveLength(0);
  });
  it("takes a file copied in Finder, whose text is its name", () => {
    expect(imagesToUpload(source("shot.png", [png("shot.png")]))).toHaveLength(1);
  });
});
