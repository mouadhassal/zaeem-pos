import { describe, expect, it } from "vitest";
import { bpToPercentText, percentToBp, sumAccounts, type PlatformAccount } from "./deliveryService";
import { tablesInArea } from "../components/layout/TableBar";

describe("delivery app commission input", () => {
  it("reads a percentage as basis points", () => {
    expect(percentToBp("15")).toBe(1500);
    expect(percentToBp(" 12.5 ")).toBe(1250);
    expect(percentToBp("12,5%")).toBe(1250);
    expect(percentToBp("0")).toBe(0);
    expect(percentToBp("100")).toBe(10000);
  });

  it("refuses what is not a percentage", () => {
    for (const bad of ["", "abc", "-5", "100.01", "101", "1.234", "١٥"]) expect(percentToBp(bad), bad).toBeNull();
  });

  it("shows basis points as the owner reads them", () => {
    expect(bpToPercentText(1250)).toBe("12.5%");
    expect(bpToPercentText(1500)).toBe("15%");
    expect(bpToPercentText(0)).toBe("0%");
  });
});

describe("apps table totals", () => {
  const row = (over: Partial<PlatformAccount>): PlatformAccount => ({
    platform_id: "p", name: "x", commission_bp: 0, active: true, orders: 0, sales_cents: 0, commission_cents: 0, net_due_cents: 0, settled_cents: 0, outstanding_cents: 0, ...over,
  });
  it("adds every column", () => {
    const t = sumAccounts([
      row({ orders: 2, sales_cents: 14000, commission_cents: 2800, net_due_cents: 11200, settled_cents: 8000, outstanding_cents: 3200 }),
      row({ orders: 1, sales_cents: 8000, commission_cents: 1000, net_due_cents: 7000, outstanding_cents: 7000 }),
    ]);
    expect(t).toEqual({ orders: 3, sales_cents: 22000, commission_cents: 3800, net_due_cents: 18200, settled_cents: 8000, outstanding_cents: 10200 });
  });
});

describe("table grid area tabs", () => {
  const tables = [{ id: "1", area_id: "hall" }, { id: "2", area_id: "roof" }, { id: "3", area_id: null }, { id: "4" }];
  it("'all' shows every table, an area only its own", () => {
    expect(tablesInArea(tables, "all").map((t) => t.id)).toEqual(["1", "2", "3", "4"]);
    expect(tablesInArea(tables, "hall").map((t) => t.id)).toEqual(["1"]);
    expect(tablesInArea(tables, "roof").map((t) => t.id)).toEqual(["2"]);
    expect(tablesInArea(tables, "gone")).toEqual([]);
  });
});
