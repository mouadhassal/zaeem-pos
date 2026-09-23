import { describe, it, expect } from "vitest";
import { reorderQuantity } from "./inventoryReorder";

describe("reorderQuantity (matches repo.rs reorder_quantity)", () => {
  it("restocks to twice the minimum", () => {
    expect(reorderQuantity(4, 10)).toBe(16);
    expect(reorderQuantity(0, 0.5)).toBe(2);
    expect(reorderQuantity(-3, 1)).toBe(2);
    expect(reorderQuantity(1.5, 2)).toBe(3);
  });
});
