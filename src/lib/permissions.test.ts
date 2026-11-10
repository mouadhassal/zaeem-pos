import { describe, it, expect } from "vitest";
import { canForceCloseShift } from "./permissions";

describe("canForceCloseShift", () => {
  it("allows manager, owner and the top platform role", () => {
    for (const r of ["MANAGER", "ADMIN", "OWNER", "PLATFORM"]) expect(canForceCloseShift(r)).toBe(true);
  });
  it("denies floor roles and anonymous", () => {
    for (const r of ["CASHIER", "KITCHEN", "ACCOUNTANT", undefined]) expect(canForceCloseShift(r)).toBe(false);
  });
});

describe("شواغر (jobs) button", () => {
  it("is in the owner's and manager's sidebar, not the floor roles'", async () => {
    const { getNavForRole } = await import("./permissions");
    for (const r of ["OWNER", "MANAGER"] as const) expect(getNavForRole(r).some((n) => n.id === "jobs")).toBe(true);
    for (const r of ["CASHIER", "KITCHEN"] as const) expect(getNavForRole(r).some((n) => n.id === "jobs")).toBe(false);
  });
  it("is hidden on POS Lite", async () => {
    const { LITE_PAGES } = await import("./litePages");
    expect(LITE_PAGES.has("jobs")).toBe(false);
  });
});
