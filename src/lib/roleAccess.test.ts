import { describe, it, expect } from "vitest";
import { applyAccess, getNavForRole, PAGE_FEATURE } from "./permissions";
import { cellOf, withCell, type AccessCell } from "./roleAccess";

const ids = (r: string | undefined, f?: Record<string, boolean> | null) => getNavForRole(r as never, f).filter((n) => n.allowed).map((n) => n.id);

describe("the owner's access table in the sidebar", () => {
  it("shows a role its normal pages until the table has been read", () => {
    expect(ids("CASHIER")).not.toContain("reports");
    expect(ids("CASHIER", null)).not.toContain("reports");
    expect(ids("MANAGER", null)).toContain("reports");
  });

  it("gives a cashier the reports page the owner opened, before the guide", () => {
    const nav = ids("CASHIER", { reports: true });
    expect(nav).toContain("reports");
    expect(nav.indexOf("reports")).toBeLessThan(nav.indexOf("guide"));
    expect(nav).not.toContain("menu");
  });

  it("takes a page away from a manager when the owner closes it", () => {
    const nav = ids("MANAGER", { reports: false, menu: true });
    expect(nav).not.toContain("reports");
    expect(nav).not.toContain("ai");
    expect(nav).toContain("menu");
  });

  it("never touches the owner or the pages outside the table", () => {
    expect(ids("OWNER", { reports: false })).toContain("reports");
    expect(ids("CASHIER", { reports: false })).toContain("pos");
    expect(ids("MANAGER", { settings: false })).toContain("customers");
  });

  it("does not add a page twice or invent one", () => {
    const nav = applyAccess(getNavForRole("MANAGER", null), { reports: true, finance: true });
    expect(nav.filter((n) => n.id === "reports")).toHaveLength(1);
    expect(nav.some((n) => n.id === "finance")).toBe(true);
    for (const k of Object.keys(PAGE_FEATURE)) expect(typeof PAGE_FEATURE[k]).toBe("string");
  });
});

describe("the access table on the settings screen", () => {
  const cells: AccessCell[] = [
    { role: "CASHIER", feature: "reports", allowed: false },
    { role: "MANAGER", feature: "reports", allowed: true },
  ];
  it("flips exactly one box", () => {
    const next = withCell(cells, "CASHIER", "reports", true);
    expect(cellOf(next, "CASHIER", "reports")).toBe(true);
    expect(cellOf(next, "MANAGER", "reports")).toBe(true);
    expect(cellOf(cells, "CASHIER", "reports")).toBe(false);
  });
});
