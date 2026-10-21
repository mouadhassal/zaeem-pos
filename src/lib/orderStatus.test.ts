import { describe, expect, it } from "vitest";
import { orderStatusLabel } from "./orderStatus";

describe("orderStatusLabel", () => {
  it("never shows a raw English status for the known ones", () => {
    for (const s of ["DRAFT", "PENDING", "PREPARING", "READY", "SERVED", "PAID", "CANCELLED", "SCHEDULED", "VOIDED"]) {
      expect(orderStatusLabel(s)).not.toBe(s);
    }
  });
  it("passes unknown values through", () => {
    expect(orderStatusLabel("X")).toBe("X");
  });
});
