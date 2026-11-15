import { describe, expect, it } from "vitest";
import { useOrderTypeStore } from "../stores/orderTypeStore";

describe("no bill for this order", () => {
  it("starts off, is switched per order, and the next order starts with the bill on again", () => {
    const s = useOrderTypeStore.getState();
    expect(s.noBill).toBe(false);
    s.setNoBill(true);
    expect(useOrderTypeStore.getState().noBill).toBe(true);
    useOrderTypeStore.getState().resetOrderInfo();
    expect(useOrderTypeStore.getState().noBill).toBe(false);
  });
});
