import { describe, expect, it } from "vitest";
import { de } from "./i18n/de";
import { en } from "./i18n/en";
import { es } from "./i18n/es";
import { fr } from "./i18n/fr";
import { pt } from "./i18n/pt";
import { ru } from "./i18n/ru";
import type { TFunction } from "./i18n";
import { explainFailure, FAILURE_CODES, isFailureCode, type FailureCode } from "./failures";

const LOCALES = { en, ru, de, es, fr, pt };

/** A t() for one locale, as the provider builds it: the key's path, then {name} filled in. */
function tFor(dict: unknown): TFunction {
  return (key, vars) => {
    const value = key.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), dict);
    if (typeof value !== "string") return key;
    return value.replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
  };
}

// The buttons each hint sends the owner to: Retry and Continue and Accept sit in the composer, the conflict one in the notice
const BUTTONS: Record<FailureCode, ("retry" | "continue" | "accept" | "resolved")[]> = {
  session_lost: ["continue", "retry"],
  quota_limit: ["continue"],
  project_unavailable: ["retry"],
  branch_gone: ["retry"],
  check_failed_again: ["continue", "accept"],
  conflict_unresolved: ["resolved"],
  stopped_by_owner: ["continue", "retry"],
  agent_reported: ["continue", "retry"],
};

describe("explainFailure", () => {
  for (const [lang, dict] of Object.entries(LOCALES)) {
    const t = tFor(dict);
    const labels = {
      retry: t("taskModal.retry"),
      continue: t("activity.continue"),
      accept: t("activity.accept"),
      resolved: t("taskModal.conflictResolved"),
    };
    describe(lang, () => {
      for (const code of FAILURE_CODES) {
        it(`${code} has its own reason and a hint that names the buttons`, () => {
          const explained = explainFailure(t, code);
          expect(explained).not.toBeNull();
          const { reason, hint } = explained!;
          expect(reason).not.toBe(`card.failure.${code}.reason`);
          expect(reason.length).toBeGreaterThan(5);
          expect(hint).not.toBe(`card.failure.${code}.hint`);
          expect(hint).not.toMatch(/\{\w+\}/);
          for (const button of BUTTONS[code]) expect(hint).toContain(`«${labels[button]}»`);
        });
      }
    });
  }

  it("gives every code a reason and a hint that differ from the other codes", () => {
    const t = tFor(en);
    const reasons = FAILURE_CODES.map((code) => explainFailure(t, code)!.reason);
    const hints = FAILURE_CODES.map((code) => explainFailure(t, code)!.hint);
    expect(new Set(reasons).size).toBe(FAILURE_CODES.length);
    expect(new Set(hints).size).toBe(FAILURE_CODES.length);
  });

  it("returns null for an unknown, empty or missing code, so the caller keeps the raw text", () => {
    const t = tFor(en);
    expect(explainFailure(t, "something_new")).toBeNull();
    expect(explainFailure(t, "")).toBeNull();
    expect(explainFailure(t, null)).toBeNull();
    expect(explainFailure(t, undefined)).toBeNull();
    expect(isFailureCode("toString")).toBe(false);
  });
});
