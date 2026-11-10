import { describe, expect, it } from "vitest";
import { detectSpeechLanguage, toSpeechChunks } from "./speech";

/** What is said, joined into one string. Every line ends as a sentence, hence the final full stop. */
const say = (md: string, lang: Parameters<typeof toSpeechChunks>[1] = "en") =>
  toSpeechChunks(md, lang)
    .map((c) => c.text)
    .join(" ");

describe("markup", () => {
  it("drops asterisks, hashes, backticks and quotes", () => {
    expect(say("## Result\n\nThis is **bold**, *italic* and ~~gone~~ text, \"quoted\".")).toBe(
      "Result. This is bold, italic and gone text, quoted.",
    );
  });

  it("reads a link by its text and a bare address by its site", () => {
    expect(say("See [the docs](https://example.com/a/b) or https://www.python.org/downloads?x=1.")).toBe(
      "See the docs or python dot org.",
    );
  });

  it("skips a code block and says so", () => {
    const out = say("Before:\n\n```ts\nconst a = 1;\n```\n\nAfter.");
    expect(out).toBe("Before: Code block skipped. After.");
    expect(say("```py\nprint('x')\n```", "ru")).toBe("Блок кода пропущен.");
  });

  it("strips list markers, quotes and checkboxes, ending each item as a sentence", () => {
    expect(say("- first\n- [x] second\n1. third\n> quoted")).toBe("first. second. third. quoted.");
  });

  it("reads a table row cell by cell and skips the separator", () => {
    expect(say("| Name | Year |\n|------|:----:|\n| orc | 2026 |")).toBe("Name, Year. orc, 2026.");
  });

  it("removes emoji", () => {
    expect(say("Done ✅ and shipped 🚀")).toBe("Done and shipped.");
  });
});

describe("pauses", () => {
  it("pauses at a line break, longer after a paragraph and a heading", () => {
    const chunks = toSpeechChunks("# Title\nline one\nline two\n\nnext paragraph", "en");
    expect(chunks.map((c) => c.pauseAfter)).toEqual([700, 250, 600, 250]);
  });

  it("splits a very long sentence so that no piece is too long", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ") + ".";
    const chunks = toSpeechChunks(long, "en");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(220);
    expect(chunks.map((c) => c.text).join(" ")).toBe(long);
  });
});

describe("numbers", () => {
  it("reads a period of years as a period, not as a minus", () => {
    expect(say("Data for 2020-2023", "ru")).toBe("Data for с 2020 по 2023.");
    expect(say("In 2020–2023 we grew")).toBe("from 2020 to 2023 we grew.");
  });

  it("reads a range of numbers and of the day", () => {
    expect(say("Take 5-10 items between 10:00-12:30")).toBe("Take 5 to 10 items between from 10:00 to 12:30.");
  });

  it("keeps ids, phones and chained numbers as they are", () => {
    expect(say("call 555-123-4567 and 1-2-3.")).toBe("call 555-123-4567 and 1-2-3.");
  });

  it("reads a sign as a minus only in front of a number", () => {
    expect(say("The value fell to -5 degrees, a well-known fact")).toBe("The value fell to minus 5 degrees, a well-known fact.");
  });

  it("says an ISO date in the language of the text", () => {
    expect(say("Released 2026-11-09", "en")).toContain("November 9, 2026");
    expect(say("Выпуск 2026-11-09", "ru")).toContain("9 ноября 2026");
    expect(say("Not a date 2026-13-45", "en")).toBe("Not a date 2026-13-45.");
  });

  it("reads versions with dots and a card number as a number", () => {
    expect(say("Python 3.12.1 fixed #1103", "ru")).toBe("Python 3 точка 12 точка 1 fixed номер 1103.");
    expect(say("About ~5 minutes")).toBe("About about 5 minutes.");
  });

  it("names a model and a commit hash", () => {
    expect(say("Use claude-sonnet-5-5 or Claude Opus 5.5")).toBe("Use Claude Sonnet 5.5 or Claude Opus 5.5.");
    expect(say("Fixed in 9864e17")).toBe("Fixed in commit hash.");
  });
});

describe("identifiers and paths", () => {
  it("splits names in backticks into words", () => {
    expect(say("Call `getUserName` and `max_retry_count` and `parse-args`.")).toBe(
      "Call get User Name and max retry count and parse args.",
    );
  });

  it("shortens a path to the file name and reads the dot", () => {
    expect(say("Edit `web/src/lib/speech.ts` and web/src/components/ChatPanel.tsx now")).toBe(
      "Edit speech dot ts and Chat Panel dot tsx now.",
    );
    expect(say("open config.json")).toBe("open config dot json.");
  });

  it("reads a short command without flags' dashes", () => {
    expect(say("Run `git rebase -i`")).toBe("Run git rebase i.");
  });

  it("does not take and/or for a path", () => {
    expect(say("this and/or that")).toBe("this and or that.");
  });
});

describe("language", () => {
  it("detects Russian by script and otherwise follows the interface", () => {
    expect(detectSpeechLanguage("Привет, мир", "en")).toBe("ru");
    expect(detectSpeechLanguage("Hello world", "ru")).toBe("en");
    expect(detectSpeechLanguage("Hello world", "de")).toBe("de");
  });
});
