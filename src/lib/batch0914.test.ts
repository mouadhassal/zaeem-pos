// 2026-11-14 batch: options pop-up choice, one-word without/extra, delivery requirements,
// splitting a cart line when options are added to some of its units.
import { beforeEach, describe, expect, it } from "vitest";
import { choiceRows, pickPairSide, quickPair, type OptionGroup } from "./itemOptions";
import { DEFAULT_PREFS, deliveryMissing, normalizePrefs, opensOptionsOnTap } from "./prefs";
import { useCartStore } from "../stores/cartStore";

const group = (choices: [string, string, number][], selection: "MULTI" | "SINGLE" = "MULTI", required = false): OptionGroup => ({
  id: "g", name: "إضافات", selection, required, sort_order: 0, is_active: true, targets: [],
  choices: choices.map(([id, name, price_cents], i) => ({ id, name, price_cents, sort_order: i })),
});

describe("options window on tap", () => {
  const optional = [{ required: false }];
  const mandatory = [{ required: false }, { required: true }];
  it("always / required / never", () => {
    expect(opensOptionsOnTap("always", optional)).toBe(true);
    expect(opensOptionsOnTap("required", optional)).toBe(false);
    expect(opensOptionsOnTap("required", mandatory)).toBe(true);
    expect(opensOptionsOnTap("never", mandatory)).toBe(false);
    expect(opensOptionsOnTap("always", [])).toBe(false);
  });
  it("defaults keep the old behaviour and old stored prefs still load", () => {
    expect(DEFAULT_PREFS.optionsOnTap).toBe("always");
    expect(DEFAULT_PREFS.printReceiptOnPay).toBe(true);
    expect(normalizePrefs({ optionsOnTap: "sometimes" }).optionsOnTap).toBe("always");
    expect(normalizePrefs({ printReceiptOnPay: false }).printReceiptOnPay).toBe(false);
  });
});

describe("ingredient typed once", () => {
  it("gives both choices", () => {
    expect(quickPair(" بصل ")).toEqual([{ name: "بدون بصل" }, { name: "زيادة بصل" }]);
    expect(quickPair("  ")).toEqual([]);
  });
  it("is one row at the till, other choices stay single", () => {
    const g = group([["a", "بدون بصل", 0], ["b", "زيادة بصل", 500], ["c", "حار", 0], ["d", "بدون مخلل", 0]]);
    const rows = choiceRows(g.choices);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "pair", label: "بصل" });
    expect(rows[1]).toMatchObject({ kind: "single", choice: { name: "حار" } });
    expect(rows[2]).toMatchObject({ kind: "single", choice: { name: "بدون مخلل" } });
  });
  it("without and extra of the same ingredient can never both be on", () => {
    const g = group([["a", "بدون بصل", 0], ["b", "زيادة بصل", 500], ["c", "حار", 0]]);
    const [w, e] = [g.choices[0]!, g.choices[1]!];
    let sel = pickPairSide(g, { g: ["c"] }, w, e);
    expect(sel.g).toEqual(["c", "a"]);
    sel = pickPairSide(g, sel, e, w);
    expect(sel.g).toEqual(["c", "b"]);
    sel = pickPairSide(g, sel, e, w);
    expect(sel.g).toEqual(["c"]);
  });
});

describe("delivery requirements", () => {
  const off = { deliveryNameRequired: false, deliveryPhoneRequired: false };
  it("needs the address always", () => {
    expect(deliveryMissing({ address: " ", name: "علي", phone: "0999" }, off)).toBe("اكتب عنوان التوصيل");
    expect(deliveryMissing({ address: "المزة", name: "", phone: "" }, off)).toBeNull();
  });
  it("needs name and phone only when the owner says so", () => {
    expect(deliveryMissing({ address: "المزة", name: "", phone: "0999" }, { ...off, deliveryNameRequired: true })).toBe("اكتب اسم العميل");
    expect(deliveryMissing({ address: "المزة", name: "علي", phone: "" }, { ...off, deliveryPhoneRequired: true })).toBe("اكتب رقم هاتف العميل");
  });
});

describe("options for some units of a line", () => {
  beforeEach(() => useCartStore.getState().clearCart());
  const add = () => useCartStore.getState().addItem({ menuItemId: "burger", name: "برغر", quantity: 1, unitPriceCents: 1000, modifiers: [], notes: "" });
  it("1 of 3 burgers without onion becomes its own line", () => {
    add(); add(); add();
    const [line] = useCartStore.getState().items;
    useCartStore.getState().setLineOptionsFor(line!.id, [{ name: "بدون بصل", priceCents: 0 }], "", 1);
    const items = useCartStore.getState().items;
    expect(items.map((i) => [i.quantity, i.modifiers.map((m) => m.name)])).toEqual([[2, []], [1, ["بدون بصل"]]]);
    expect(useCartStore.getState().subtotal()).toBe(3000);
  });
  it("joins a line that already has the same options", () => {
    add(); add(); add();
    const first = useCartStore.getState().items[0]!;
    useCartStore.getState().setLineOptionsFor(first.id, [{ name: "بدون بصل", priceCents: 0 }], "", 1);
    useCartStore.getState().setLineOptionsFor(first.id, [{ name: "بدون بصل", priceCents: 0 }], "", 1);
    expect(useCartStore.getState().items.map((i) => i.quantity)).toEqual([1, 2]);
  });
  it("the whole quantity changes the line itself", () => {
    add(); add();
    const first = useCartStore.getState().items[0]!;
    useCartStore.getState().setLineOptionsFor(first.id, [{ name: "زيادة جبنة", priceCents: 500 }], "", 2);
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(2);
    expect(useCartStore.getState().subtotal()).toBe(3000);
  });
});
