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
