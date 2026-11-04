import { beforeEach, describe, expect, it } from "vitest";
import { useCartStore } from "./cartStore";

const base = { menuItemId: "p1", name: "Biscuits", categoryName: "", unitPriceCents: 1500, notes: "", modifiers: [] };

describe("addItem", () => {
  beforeEach(() => useCartStore.setState({ items: [] }));

  it("adds the scanned quantity to a line that is already there (a carton of 12)", () => {
    const { addItem } = useCartStore.getState();
    addItem({ ...base, quantity: 1 });
    addItem({ ...base, quantity: 12 });
    expect(useCartStore.getState().items.map((i) => i.quantity)).toEqual([13]);
  });

  it("still adds one when a tapped card passes quantity 1, and never less than one", () => {
    const { addItem } = useCartStore.getState();
    addItem({ ...base, quantity: 1 });
    addItem({ ...base, quantity: 1 });
    addItem({ ...base, quantity: 0 });
    expect(useCartStore.getState().items.map((i) => i.quantity)).toEqual([3]);
  });

  it("keeps a weighed portion as its own line", () => {
    const { addItem } = useCartStore.getState();
    addItem({ ...base, quantity: 1, weightGrams: 285, unitPriceCents: 34200 });
    addItem({ ...base, quantity: 1, weightGrams: 285, unitPriceCents: 34200 });
    expect(useCartStore.getState().items).toHaveLength(2);
  });
});
