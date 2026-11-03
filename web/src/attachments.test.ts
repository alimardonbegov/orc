import { describe, expect, it } from "vitest";
import { countImages, imageMarker, insertMarker, parseDescription } from "./attachments";

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
