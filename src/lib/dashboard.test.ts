import { describe, expect, it, vi } from "vitest";
import {
  CARD_DEFS, barHeights, busiestHour, cardVisible, classShares, dayBars, daysText, hoursText, hourBars, hrTotals, isOneDay, lowStockRows,
  monthOfRange, moneyChange, moneySplit, periodRange, pointsChange, previousMonth, previousPeriodRange, visibleCardIds, visibleTabs,
  type CardContext,
} from "./dashboard";
import { businessPeriodStart } from "./businessDay";
import { openPageTab, takePendingTab } from "./deepLink";

const at = (s: string) => new Date(s);
const ALL_PAGES = new Set(["reports", "finance", "inventory", "debt", "payroll", "staff", "shift", "dashboard"]);
const ctx = (over: Partial<CardContext> = {}): CardContext => ({ pages: ALL_PAGES, modules: null, hasKitchen: true, ...over });

describe("period ranges use the 05:00 business day", () => {
  const now = at("2026-11-14T14:00:00"); // a Saturday
  it("today starts at 05:00, and before 05:00 it is still yesterday's business day", () => {
    expect(periodRange("today", now).startIso).toBe(at("2026-11-14T05:00:00").toISOString());
    expect(periodRange("today", at("2026-11-15T01:30:00")).startIso).toBe(at("2026-11-14T05:00:00").toISOString());
  });
  it("week starts Sunday, month on the 1st, year on 1 January", () => {
    expect(periodRange("week", now).startIso).toBe(at("2026-11-08T05:00:00").toISOString());
    expect(periodRange("month", now).startIso).toBe(at("2026-11-01T05:00:00").toISOString());
    expect(periodRange("year", now).startIso).toBe(at("2026-01-01T05:00:00").toISOString());
    expect(businessPeriodStart("year", at("2027-01-01T02:00:00"))).toEqual(at("2026-01-01T05:00:00"));
  });
  it("every period ends now", () => {
    for (const p of ["today", "week", "month", "year"] as const) expect(periodRange(p, now).endIso).toBe(now.toISOString());
  });
  it("a chosen period runs from 05:00 of its first day to 05:00 after its last day", () => {
    const r = periodRange("custom", at("2026-11-30T12:00:00"), { start: "2026-11-10", end: "2026-11-12" });
    expect(r.startIso).toBe(at("2026-11-10T05:00:00").toISOString());
    expect(r.endIso).toBe(new Date(at("2026-11-13T05:00:00").getTime() - 1).toISOString());
  });
  it("a chosen period never ends in the future, and swapped dates are put right", () => {
    const r = periodRange("custom", now, { start: "2026-11-20", end: "2026-11-12" });
    expect(r.startIso).toBe(at("2026-11-12T05:00:00").toISOString());
    expect(r.endIso).toBe(now.toISOString());
  });
  it("a chosen period without dates falls back to today", () => {
    expect(periodRange("custom", now, null)).toEqual(periodRange("today", now));
  });
});

describe("the period before", () => {
  const now = at("2026-11-14T14:00:00");
  it("today is compared with the same hours yesterday", () => {
    const r = periodRange("today", now);
    const p = previousPeriodRange("today", r);
    expect(p.startIso).toBe(at("2026-11-13T05:00:00").toISOString());
    expect(p.endIso).toBe(at("2026-11-13T14:00:00").toISOString());
  });
  it("the month so far is compared with the same stretch of last month", () => {
    const r = periodRange("month", now);
    const p = previousPeriodRange("month", r);
    expect(p.startIso).toBe(at("2026-10-01T05:00:00").toISOString());
    expect(p.endIso).toBe(at("2026-10-14T14:00:00").toISOString());
  });
  it("the stretch never runs into the current period (31 days against a 28-day month)", () => {
    const r = periodRange("month", at("2026-03-31T20:00:00"));
    const p = previousPeriodRange("month", r);
    expect(new Date(p.endIso).getTime()).toBeLessThan(new Date(r.startIso).getTime());
  });
  it("week and year shift by a week and a year", () => {
    const w = previousPeriodRange("week", periodRange("week", now));
    expect(w.startIso).toBe(at("2026-11-01T05:00:00").toISOString());
    const y = previousPeriodRange("year", periodRange("year", now));
    expect(y.startIso).toBe(at("2025-01-01T05:00:00").toISOString());
  });
  it("a chosen period is compared with the same length right before it", () => {
    const r = periodRange("custom", now, { start: "2026-11-10", end: "2026-11-12" });
    const p = previousPeriodRange("custom", r);
    expect(new Date(p.endIso).getTime()).toBe(new Date(r.startIso).getTime() - 1);
  });
  it("names the month a period ends in, and the month before it", () => {
    expect(monthOfRange(periodRange("month", now))).toBe("2026-11");
    expect(previousMonth("2026-11")).toBe("2026-10");
    expect(previousMonth("2026-01")).toBe("2025-12");
  });
  it("knows a single day", () => {
    expect(isOneDay(periodRange("today", now))).toBe(true);
    expect(isOneDay(periodRange("week", now))).toBe(false);
  });
});

describe("change against the period before", () => {
  it("sales up is green, down is red", () => {
    expect(moneyChange(120, 100)).toEqual({ text: "▲ 20%", tone: "good", dir: "up" });
    expect(moneyChange(80, 100)).toEqual({ text: "▼ 20%", tone: "bad", dir: "down" });
  });
  it("costs up is red, down is green", () => {
    expect(moneyChange(120, 100, false).tone).toBe("bad");
    expect(moneyChange(80, 100, false).tone).toBe("good");
  });
  it("no change, and nothing before", () => {
    expect(moneyChange(100, 100)).toEqual({ text: "—", tone: "neutral", dir: "flat" });
    expect(moneyChange(0, 0).tone).toBe("neutral");
    expect(moneyChange(50, 0).text).toBe("جديد");
  });
  it("a profit that was a loss before says only which way it went", () => {
    expect(moneyChange(500, -200).text).toBe("▲ أفضل");
    expect(moneyChange(-500, -200).text).toBe("▼ أسوأ");
  });
  it("shares of sales change in points (basis points in, points out)", () => {
    expect(pointsChange(3250, 3000)).toEqual({ text: "▲ 2.5 نقطة", tone: "bad", dir: "up" });
    expect(pointsChange(2800, 3000)).toEqual({ text: "▼ 2 نقطة", tone: "good", dir: "down" });
    expect(pointsChange(3000, 3000).text).toBe("—");
    expect(pointsChange(3500, 3000, true).tone).toBe("good");
  });
});

describe("which cards show", () => {
  it("everything shows to someone who can open every page, in a shop with every module", () => {
    expect(visibleCardIds(ctx()).size).toBe(CARD_DEFS.length);
    expect(visibleTabs(ctx())).toEqual(["summary", "sales", "finance", "stock", "hr"]);
  });
  it("a card needs the page it opens: no finance page, no money cards", () => {
    const pages = new Set(["reports", "inventory", "debt", "payroll", "staff", "shift"]);
    const ids = visibleCardIds(ctx({ pages }));
    expect(ids.has("f_profit")).toBe(false);
    expect(ids.has("profit_month")).toBe(false);
    expect(ids.has("s_sales")).toBe(true);
    expect(visibleTabs(ctx({ pages }))).not.toContain("finance");
  });
  it("switched-off modules hide their cards and their tab", () => {
    const off = ctx({ modules: { inventory: false, hr: false, debt: false } });
    const ids = visibleCardIds(off);
    for (const gone of ["k_value", "k_low", "attn_stock", "h_salaries", "h_absence", "h_advances", "attn_debts"]) {
      // the absence card opens the staff page, which is not a module page: it stays
      if (gone === "h_absence") expect(ids.has(gone)).toBe(true);
      else expect(ids.has(gone), gone).toBe(false);
    }
    expect(visibleTabs(off)).not.toContain("stock");
    expect(visibleTabs(off)).toContain("hr");
    expect(visibleTabs(ctx({ modules: { inventory: false, hr: false }, pages: new Set(["reports", "finance", "shift"]) }))).not.toContain("hr");
  });
  it("modules not loaded yet count as on", () => {
    expect(visibleCardIds(ctx({ modules: undefined })).has("k_value")).toBe(true);
  });
  it("late kitchen orders need a kitchen", () => {
    const late = CARD_DEFS.find((c) => c.id === "attn_late")!;
    expect(cardVisible(late, ctx({ hasKitchen: false }))).toBe(false);
    expect(cardVisible(late, ctx())).toBe(true);
  });
  it("a person with no allowed page sees no tab", () => {
    expect(visibleTabs(ctx({ pages: new Set(["pos"]) }))).toEqual([]);
  });
});

describe("charts", () => {
  it("labels sales per day with day/month", () => {
    expect(dayBars([{ date: "2026-11-05", net_sales_cents: 700 }])).toEqual([{ label: "5/11", value: 700 }]);
  });
  it("adds a long period up by month", () => {
    const days = Array.from({ length: 90 }, (_, i) => {
      const d = new Date(2026, 0, 1 + i);
      return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, net_sales_cents: 10 };
    });
    const bars = dayBars(days);
    expect(bars.map((b) => b.label)).toEqual(["1", "2", "3"]);
    expect(bars[0]!.value).toBe(310);
  });
  it("puts the hours in order and finds the busiest", () => {
    const rows = [
      { key: "13", label: "13:00", amount_cents: 500 },
      { key: "9", label: "09:00", amount_cents: 100 },
      { key: "21", label: "21:00", amount_cents: 900 },
    ];
    expect(hourBars(rows).map((b) => b.label)).toEqual(["09", "13", "21"]);
    expect(busiestHour(rows)?.label).toBe("21:00");
    expect(busiestHour([{ label: "10:00", amount_cents: 0 }])).toBeNull();
  });
  it("draws bars as a share of the tallest, never invisible when there are sales", () => {
    expect(barHeights([{ label: "a", value: 200 }, { label: "b", value: 100 }, { label: "c", value: 1 }, { label: "d", value: 0 }])).toEqual([100, 50, 3, 0]);
    expect(barHeights([{ label: "a", value: 0 }])).toEqual([0]);
  });
});

describe("money, stock and people", () => {
  it("splits sales into goods, salaries, other costs and what is left, adding up to 100%", () => {
    const parts = moneySplit({ net_sales_cents: 1000, cogs_cents: 300, salaries_cents: 200, operating_expenses_cents: 350, net_profit_cents: 350 });
    expect(parts.map((p) => [p.id, p.cents, p.pct])).toEqual([["goods", 300, 30], ["salaries", 200, 20], ["other", 150, 15], ["profit", 350, 35]]);
    expect(parts.reduce((s, p) => s + p.pct, 0)).toBe(100);
  });
  it("a loss leaves no 'left for you' part, and no sales leaves no bar", () => {
    const parts = moneySplit({ net_sales_cents: 1000, cogs_cents: 600, salaries_cents: 300, operating_expenses_cents: 500, net_profit_cents: -100 });
    expect(parts.find((p) => p.id === "profit")).toBeUndefined();
    expect(moneySplit({ net_sales_cents: 0, cogs_cents: 0, salaries_cents: 0, operating_expenses_cents: 0, net_profit_cents: 0 })).toEqual([]);
  });
  it("lists the cost classes that cost something, food first", () => {
    const s = classShares([
      { class: "SHISHA", cost_cents: 50, bp: 500 },
      { class: "BEVERAGE", cost_cents: 100, bp: 1000 },
      { class: "FOOD", cost_cents: 300, bp: 3000 },
      { class: "OTHER", cost_cents: 0, bp: 0 },
    ]);
    expect(s).toEqual([{ cls: "FOOD", bp: 3000 }, { cls: "BEVERAGE", bp: 1000 }, { cls: "SHISHA", bp: 500 }]);
  });
  it("low stock: only items with an alert level, the emptiest first", () => {
    const rows = [
      { name: "a", on_hand: 5, min_stock: 10 },
      { name: "b", on_hand: 0, min_stock: 10 },
      { name: "c", on_hand: 50, min_stock: 10 },
      { name: "d", on_hand: 0, min_stock: 0 },
      { name: "e", on_hand: 10, min_stock: 10 },
    ];
    expect(lowStockRows(rows).map((r) => r.name)).toEqual(["b", "a", "e"]);
  });
  it("adds the staff month up and counts who is not paid", () => {
    const t = hrTotals(
      [
        { pay_set: true, earned_cents: 1000, status: "PAID" },
        { pay_set: true, earned_cents: 500, status: "DRAFT" },
        { pay_set: false, earned_cents: 0, status: "NO_PAY" },
      ],
      [{ absent_days: 2, overtime_minutes: 90, overtime_pay_cents: 40 }, { absent_days: 1, overtime_minutes: 30, overtime_pay_cents: 10 }],
    );
    expect(t).toEqual({ salaries_cents: 1500, people: 2, unpaid: 1, absent_days: 3, overtime_minutes: 120, overtime_pay_cents: 50 });
  });
  it("says hours and days in plain Arabic", () => {
    expect(hoursText(150)).toBe("2.5 ساعة");
    expect(hoursText(60)).toBe("ساعة");
    expect(hoursText(0)).toBe("0 ساعة");
    expect(daysText(0)).toBe("لا غياب");
    expect(daysText(2)).toBe("يومان");
    expect(daysText(5)).toBe("5 أيام");
  });
});

describe("opening a report on the right tab", () => {
  vi.stubGlobal("window", { dispatchEvent: () => true });
  it("lands on the tab the card asked for, once", () => {
    openPageTab("nonexistent-page", "kitchen");
    expect(takePendingTab("nonexistent-page", ["sales", "kitchen"] as const, "sales")).toBe("kitchen");
    expect(takePendingTab("nonexistent-page", ["sales", "kitchen"] as const, "sales")).toBe("sales");
  });
  it("ignores a tab the page does not have, another page's request and a stale one", () => {
    openPageTab("reports", "nope");
    expect(takePendingTab("reports", ["sales"] as const, "sales")).toBe("sales");
    openPageTab("finance", "pnl");
    expect(takePendingTab("reports", ["sales", "pnl"] as const, "sales")).toBe("sales");
    openPageTab("reports", "kitchen");
    expect(takePendingTab("reports", ["sales", "kitchen"] as const, "sales", Date.now() + 60_000)).toBe("sales");
  });
});
