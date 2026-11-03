import { describe, it, expect } from "vitest";
import { effectiveHiddenModels, parseHiddenModels } from "./models";

describe("parseHiddenModels", () => {
  it("parses a JSON list and drops non-strings", () => {
    expect(parseHiddenModels('["claude-opus-5", 3, "x"]')).toEqual(["claude-opus-5", "x"]);
  });

  it("an empty and a broken value mean nothing is hidden", () => {
    expect(parseHiddenModels(undefined)).toEqual([]);
    expect(parseHiddenModels("")).toEqual([]);
    expect(parseHiddenModels("not json")).toEqual([]);
    expect(parseHiddenModels('{"a": 1}')).toEqual([]);
  });
});

describe("effectiveHiddenModels", () => {
  it("without its own list the project uses the shared one", () => {
    expect(effectiveHiddenModels({ hidden_models: null }, ["a"])).toEqual(["a"]);
    expect(effectiveHiddenModels(null, ["a"])).toEqual(["a"]);
  });

  it("the project's own list replaces the shared one entirely, even an empty one", () => {
    expect(effectiveHiddenModels({ hidden_models: ["b"] }, ["a"])).toEqual(["b"]);
    expect(effectiveHiddenModels({ hidden_models: [] }, ["a"])).toEqual([]);
  });
});
