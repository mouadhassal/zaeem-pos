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

describe("typed quantity and special prices", () => {
  beforeEach(() => useCartStore.getState().clearCart());

  it("sets a typed quantity, never below one, never on a non-integer", () => {
    const s = useCartStore.getState();
    s.addItem({ ...base, quantity: 1 });
    const id = useCartStore.getState().items[0]!.id;
    s.setQuantity(id, 10);
    expect(useCartStore.getState().items[0]!.quantity).toBe(10);
    s.setQuantity(id, 0);
    s.setQuantity(id, 2.5);
    expect(useCartStore.getState().items[0]!.quantity).toBe(10);
  });

  it("a special price becomes part of the order discount and follows the quantity", () => {
    const s = useCartStore.getState();
    s.addItem({ ...base, quantity: 2 });
    const id = useCartStore.getState().items[0]!.id;
    s.setLineCut(id, 500);
    expect(useCartStore.getState().discountCents).toBe(1000);
    expect(useCartStore.getState().discountReason).toBe("سعر خاص");
    s.updateQuantity(id, 1);
    expect(useCartStore.getState().discountCents).toBe(1500);
    s.setQuantity(id, 5);
    expect(useCartStore.getState().discountCents).toBe(2500);
    s.removeItem(id);
    expect(useCartStore.getState().discountCents).toBe(0);
  });

  it("adds to a typed discount instead of replacing it, and cannot cut below zero", () => {
    const s = useCartStore.getState();
    s.addItem({ ...base, quantity: 1 });
    const id = useCartStore.getState().items[0]!.id;
    s.setDiscount(300, "مكافأة ولاء");
    s.setLineCut(id, 99999);
    expect(useCartStore.getState().discountCents).toBe(300 + 1500);
    expect(useCartStore.getState().discountReason).toBe("مكافأة ولاء + سعر خاص");
    s.setLineCut(id, 0);
    expect(useCartStore.getState().discountCents).toBe(300);
  });

  it("does not top up a line that has a special price", () => {
    const s = useCartStore.getState();
    s.addItem({ ...base, quantity: 1 });
    s.setLineCut(useCartStore.getState().items[0]!.id, 200);
    s.addItem({ ...base, quantity: 1 });
    expect(useCartStore.getState().items).toHaveLength(2);
  });
});
