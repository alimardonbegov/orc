import { describe, expect, it } from "vitest";
import { foldSeries, OTHER_KEY, seriesOrder, seriesPalette } from "./series";

describe("seriesPalette", () => {
  it("models are colored by the fixed list order, not by magnitude", () => {
    // Sonnet is passed first, but slot 1 still belongs to Opus 5.5: it comes earlier in models.ts
    const { order, color } = seriesPalette("by_model", ["claude-sonnet-5", "claude-opus-5-5", "zzz-custom"]);
    expect(order).toEqual(["claude-opus-5-5", "claude-sonnet-5", "zzz-custom"]);
    expect(color.get("claude-opus-5-5")).toBe("var(--cat-1)");
    expect(color.get("claude-sonnet-5")).toBe("var(--cat-2)");
    expect(color.get("zzz-custom")).toBe("var(--cat-3)");
  });

  it("the color sticks to the name: a subset of keys does not recolor the neighbors", () => {
    const full = seriesPalette("by_project", ["alpha", "beta", "gamma"]).color;
    const part = seriesPalette("by_project", ["beta", "gamma"]).color;
    // beta is slot 2 in the full set, slot 1 in the trimmed one: the order is alphabetical within the set,
    // so stability is guaranteed only with the same set of keys over the period
    expect(full.get("alpha")).toBe("var(--cat-1)");
    expect(part.get("beta")).toBe("var(--cat-1)");
  });

  it("statuses are colored with the board shades and go in the order done → failed", () => {
    const { order, color } = seriesPalette("by_status", ["failed", "done"]);
    expect(order).toEqual(["done", "failed"]);
    expect(color.get("done")).toBe("var(--st-done)");
    expect(color.get("failed")).toBe("var(--st-failed)");
  });

  it("the ninth and further rows collapse into gray \"other\"", () => {
    const keys = Array.from({ length: 10 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const { order, color } = seriesPalette("by_project", keys);
    expect(order).toHaveLength(8);
    expect(order[7]).toBe(OTHER_KEY);
    expect(color.get(OTHER_KEY)).toBe("var(--ink-faint)");
    const folded = foldSeries({ p00: 1, p07: 7, p08: 8, p09: 9 }, order, (a, b) => a + b);
    expect(folded).toEqual({ p00: 1, [OTHER_KEY]: 24 });
  });

  it("the project order is alphabetical and without duplicates", () => {
    expect(seriesOrder("by_project", ["b", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("modelLabel", () => {
  it("an id with a snapshot date is labelled as the same model", async () => {
    const { modelLabel } = await import("./models");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(modelLabel("claude-haiku-4-5-custom")).toBe("claude-haiku-4-5-custom");
  });
});
