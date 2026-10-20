import { describe, expect, it } from "vitest";
import {
  customModifiers,
  groupsForItem,
  lineKey,
  missingRequired,
  quickChoice,
  selectionFromModifiers,
  selectionToModifiers,
  toggleChoice,
  type OptionGroup,
} from "./itemOptions";

const group = (over: Partial<OptionGroup> & { id: string }): OptionGroup => ({
  name: "g",
  selection: "MULTI",
  required: false,
  sort_order: 0,
  is_active: true,
  choices: [
    { id: `${over.id}-a`, name: "بدون بصل", price_cents: 0, sort_order: 0 },
    { id: `${over.id}-b`, name: "زيادة جبنة", price_cents: 2000, sort_order: 1 },
  ],
  targets: [{ target_type: "CATEGORY", target_id: "cat-sandwich" }],
  ...over,
});

describe("quickChoice", () => {
  it("builds the Arabic wording", () => {
    expect(quickChoice("without", " بصل ").name).toBe("بدون بصل");
    expect(quickChoice("extra", "جبنة").name).toBe("زيادة جبنة");
    expect(quickChoice("plain", "حار").name).toBe("حار");
  });
});

describe("groupsForItem", () => {
  const groups = [
    group({ id: "g1", sort_order: 2 }),
    group({ id: "g2", sort_order: 1, targets: [{ target_type: "ITEM", target_id: "falafel" }] }),
    group({ id: "g3", is_active: false }),
    group({ id: "g4", choices: [] }),
  ];
  it("matches by category and by item, in owner order", () => {
    expect(groupsForItem(groups, "x", "cat-sandwich").map((g) => g.id)).toEqual(["g1"]);
    expect(groupsForItem(groups, "falafel", "cat-sandwich").map((g) => g.id)).toEqual(["g2", "g1"]);
  });
  it("hides inactive and empty groups and unrelated items", () => {
    expect(groupsForItem(groups, "cola", "cat-drinks")).toEqual([]);
    expect(groupsForItem(groups, "x", null)).toEqual([]);
  });
});

describe("selection", () => {
  const multi = group({ id: "m" });
  const single = group({ id: "s", selection: "SINGLE", required: true });

  it("MULTI toggles on and off", () => {
    let sel = toggleChoice(multi, {}, "m-a");
    sel = toggleChoice(multi, sel, "m-b");
    expect(sel.m).toEqual(["m-a", "m-b"]);
    sel = toggleChoice(multi, sel, "m-a");
    expect(sel.m).toEqual(["m-b"]);
  });

  it("SINGLE keeps exactly one pick", () => {
    let sel = toggleChoice(single, {}, "s-a");
    sel = toggleChoice(single, sel, "s-b");
    expect(sel.s).toEqual(["s-b"]);
    sel = toggleChoice(single, sel, "s-b");
    expect(sel.s).toEqual([]);
  });

  it("flags required groups with nothing picked", () => {
    expect(missingRequired([multi, single], {})).toEqual(["g"]);
    expect(missingRequired([multi, single], { s: ["s-a"] })).toEqual([]);
  });

  it("turns picks into modifiers with catalogue prices, in catalogue order", () => {
    const mods = selectionToModifiers([multi], { m: ["m-b", "m-a"] });
    expect(mods).toEqual([
      { name: "بدون بصل", priceCents: 0 },
      { name: "زيادة جبنة", priceCents: 2000 },
    ]);
  });
});

describe("lineKey", () => {
  const base = { menuItemId: "burger", modifiers: [], notes: "" };
  it("same item with the same options is one line, whatever the pick order", () => {
    const a = lineKey({ ...base, modifiers: [{ name: "x", priceCents: 0 }, { name: "y", priceCents: 0 }] });
    const b = lineKey({ ...base, modifiers: [{ name: "y", priceCents: 0 }, { name: "x", priceCents: 0 }] });
    expect(a).toBe(b);
  });
  it("different options, notes or gift status are different lines", () => {
    const plain = lineKey(base);
    expect(lineKey({ ...base, modifiers: [{ name: "بدون بصل", priceCents: 0 }] })).not.toBe(plain);
    expect(lineKey({ ...base, notes: "حار" })).not.toBe(plain);
    expect(lineKey({ ...base, comped: true })).not.toBe(plain);
  });
});

describe("editing a line", () => {
  const g = group({ id: "m" });
  const single = group({ id: "s", selection: "SINGLE" });
  it("rebuilds the picker state from the modifiers already on the line", () => {
    const sel = selectionFromModifiers([g, single], [{ name: "زيادة جبنة" }]);
    expect(sel.m).toEqual(["m-b"]);
    expect(sel.s).toEqual(["s-b"]);
  });
  it("keeps modifiers that no longer belong to any group", () => {
    const left = customModifiers([g], [
      { name: "زيادة جبنة", priceCents: 2000 },
      { name: "خيار قديم", priceCents: 500 },
    ]);
    expect(left).toEqual([{ name: "خيار قديم", priceCents: 500 }]);
  });
});
