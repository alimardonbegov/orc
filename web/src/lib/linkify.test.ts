import { describe, expect, it } from "vitest";
import { linkify, shortenUrl } from "./linkify";

describe("linkify", () => {
  it("leaves text without links as one chunk", () => {
    expect(linkify("nothing here")).toEqual([{ kind: "text", text: "nothing here" }]);
    expect(linkify("")).toEqual([]);
  });

  it("makes a bare address a link and keeps the text around", () => {
    expect(linkify("see https://example.com/a now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", href: "https://example.com/a", label: "example.com/a" },
      { kind: "text", text: " now" },
    ]);
  });

  it("does not take sentence punctuation or an unmatched bracket into the address", () => {
    const chunks = linkify("(see https://example.com/a), then https://example.com/b.");
    expect(chunks.filter((c) => c.kind === "link").map((c) => c.kind === "link" && c.href)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(chunks[chunks.length - 1]).toEqual({ kind: "text", text: "." });
  });

  it("keeps balanced brackets inside the address", () => {
    const [link] = linkify("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(link).toMatchObject({ kind: "link", href: "https://en.wikipedia.org/wiki/Foo_(bar)" });
  });

  it("shows the label of a markdown link", () => {
    expect(linkify("[the artifact](https://claude.ai/artifact/abc)")).toEqual([
      { kind: "link", href: "https://claude.ai/artifact/abc", label: "the artifact" },
    ]);
  });

  it("handles an address in angle brackets", () => {
    expect(linkify("<https://example.com/x>")).toEqual([
      { kind: "link", href: "https://example.com/x", label: "example.com/x" },
    ]);
  });

  it("never makes a link out of a non-http scheme", () => {
    expect(linkify("[x](javascript:alert(1))")).toEqual([{ kind: "text", text: "[x](javascript:alert(1))" }]);
    expect(linkify("ftp://example.com")).toEqual([{ kind: "text", text: "ftp://example.com" }]);
  });

  it("does not include asterisks in a bare URL", () => {
    expect(linkify("**https://claude.ai/artifact/abc**")).toEqual([
      { kind: "text", text: "**" },
      { kind: "link", href: "https://claude.ai/artifact/abc", label: "claude.ai/artifact/abc" },
      { kind: "text", text: "**" },
    ]);
  });
});

describe("shortenUrl", () => {
  it("drops the scheme, www and the trailing slash", () => {
    expect(shortenUrl("https://www.example.com/")).toBe("example.com");
    expect(shortenUrl("http://example.com/a/")).toBe("example.com/a");
  });

  it("cuts a long address in the middle and keeps the tail", () => {
    const url = "https://claude.ai/code/artifact/0a1b2c3d-4e5f-6789-abcd-ef0123456789";
    const shown = shortenUrl(url);
    expect(shown.length).toBeLessThanOrEqual(44);
    expect(shown).toContain("…");
    expect(shown.startsWith("claude.ai/code")).toBe(true);
    expect(shown.endsWith("ef0123456789")).toBe(true);
  });
});
