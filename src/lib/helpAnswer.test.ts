import { describe, expect, it } from "vitest";
import { excerptsFor, matchGuide, offlineAnswer, suggestionsFor, visibleChapters } from "./helpAnswer";
import { ALL_CHAPTERS } from "./guide";

describe("help matching", () => {
  it("finds the guide task for a how-to question", () => {
    const m = matchGuide("كيف أستورد المنتجات من Excel؟", ALL_CHAPTERS);
    expect(m.length).toBeGreaterThan(0);
    expect(m[0]!.task.title).toContain("المنتجات");
  });

  it("matches loosely typed Arabic (ال, hamza, ta marbuta)", () => {
    const a = matchGuide("الباركود", ALL_CHAPTERS);
    const b = matchGuide("باركود", ALL_CHAPTERS);
    expect(a.length).toBeGreaterThan(0);
    expect(a[0]!.task.id).toBe(b[0]!.task.id);
  });

  it("gives nothing for a question the guide does not cover", () => {
    expect(matchGuide("ما عاصمة فرنسا", ALL_CHAPTERS)).toEqual([]);
    expect(matchGuide("   ", ALL_CHAPTERS)).toEqual([]);
  });

  it("keeps the excerpts under the cap and numbers the steps", () => {
    const matches = matchGuide("استلام بضاعة من مورد", ALL_CHAPTERS, 8);
    const text = excerptsFor(matches, 1500);
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text).toMatch(/\n1\. /);
  });

  it("the offline answer is the guide itself, or an honest not-found", () => {
    expect(offlineAnswer([])).toContain("لم أجد");
    const m = matchGuide("جرد المخزون", ALL_CHAPTERS);
    expect(offlineAnswer(m)).toContain("**");
    expect(offlineAnswer(m)).not.toContain("##");
  });

  it("a cashier is not told about screens that are not theirs", () => {
    const cashier = visibleChapters("CASHIER", false);
    const owner = visibleChapters("OWNER", false);
    expect(cashier.length).toBeLessThan(owner.length);
    expect(matchGuide("رواتب الموظفين", cashier)).toEqual([]);
  });

  it("offers suggestions for every role", () => {
    expect(suggestionsFor("CASHIER").length).toBeGreaterThan(2);
    expect(suggestionsFor("OWNER").length).toBeGreaterThan(2);
    expect(suggestionsFor(undefined).length).toBeGreaterThan(0);
  });
});
