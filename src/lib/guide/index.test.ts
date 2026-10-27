import { describe, expect, it } from "vitest";
import { ALL_CHAPTERS, chaptersFor, guideRoleOf, normalizeArabic, searchChapters } from "./index";
import { ALL_ROLES } from "./types";
import { LITE_PAGES } from "../litePages";

describe("guide content", () => {
  it("chapter and task ids are unique", () => {
    const chapters = ALL_CHAPTERS.map((c) => c.id);
    expect(new Set(chapters).size).toBe(chapters.length);
    for (const c of ALL_CHAPTERS) {
      const ids = c.tasks.map((t) => t.id);
      expect(new Set(ids).size, `duplicate task id in ${c.id}`).toBe(ids.length);
    }
  });

  it("every task says something a person can follow", () => {
    for (const c of ALL_CHAPTERS) {
      expect(c.roles.length, `${c.id} has no roles`).toBeGreaterThan(0);
      for (const t of c.tasks) {
        const body = (t.steps?.length ?? 0) + (t.points?.length ?? 0);
        expect(body, `${c.id}/${t.id} has no steps or points`).toBeGreaterThan(0);
        expect(t.title.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("every role gets at least a few chapters", () => {
    for (const role of ALL_ROLES) {
      expect(chaptersFor(role, false).length, role).toBeGreaterThanOrEqual(4);
    }
  });

  it("a cashier does not get back-office chapters, a manager does", () => {
    const cashier = chaptersFor("CASHIER", false).map((c) => c.id);
    expect(cashier).toContain("selling");
    expect(cashier).not.toContain("menu");
    expect(cashier).not.toContain("settings");
    expect(chaptersFor("MANAGER", false).map((c) => c.id)).toContain("menu");
  });

  it("the kitchen sees the kitchen screen, not the till", () => {
    const kitchen = chaptersFor("KITCHEN", false).map((c) => c.id);
    expect(kitchen).toContain("kitchen");
    expect(kitchen).not.toContain("selling");
  });

  it("POS Lite sees nothing it does not have", () => {
    const lite = chaptersFor(null, true);
    const ids = lite.map((c) => c.id);
    for (const gone of ["reports", "finance", "inventory", "debt", "loyalty", "owner-dashboard", "ai-menu", "ai-assistant"]) {
      expect(ids, gone).not.toContain(gone);
    }
    for (const c of lite) {
      expect(c.tasks.some((t) => t.fullOnly), `${c.id} still has a Full-only task`).toBe(false);
    }
    // shared chapters stay, minus their Full-only tasks
    const selling = lite.find((c) => c.id === "selling")!;
    expect(selling.tasks.map((t) => t.id)).not.toContain("sell-debt");
    expect(selling.tasks.map((t) => t.id)).toContain("sell-pay");
  });

  it("a chapter's page is a real sidebar page, and Lite chapters point only at Lite pages", () => {
    for (const c of chaptersFor(null, true)) {
      if (c.page) expect(LITE_PAGES.has(c.page), `${c.id} -> ${c.page}`).toBe(true);
    }
  });

  it("maps signed-in roles", () => {
    expect(guideRoleOf("OWNER")).toBe("OWNER");
    expect(guideRoleOf("ADMIN")).toBe("MANAGER");
    expect(guideRoleOf("kitchen")).toBe("KITCHEN");
    expect(guideRoleOf(undefined)).toBe("CASHIER");
  });
});

describe("guide search", () => {
  it("ignores diacritics and loose letters", () => {
    expect(normalizeArabic("الفَاتُورَة")).toBe(normalizeArabic("الفاتوره"));
    expect(normalizeArabic("إضافة")).toBe(normalizeArabic("اضافه"));
  });

  it("finds the refund task by a word a person would type", () => {
    const found = searchChapters(chaptersFor(null, false), "استرداد");
    expect(found.flatMap((c) => c.tasks.map((t) => t.id))).toContain("history-refund");
  });

  it("every typed word must match", () => {
    const found = searchChapters(chaptersFor(null, false), "طابعة مطبخ قسم");
    expect(found.length).toBeGreaterThan(0);
    expect(searchChapters(chaptersFor(null, false), "كلمةغيرموجودةإطلاقا")).toEqual([]);
  });

  it("an empty query keeps everything", () => {
    const all = chaptersFor(null, false);
    expect(searchChapters(all, "   ")).toEqual(all);
  });
});
