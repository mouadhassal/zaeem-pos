import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, billItemName, normalizePrefs, parseTypedQuantity, pickupChoiceLabel, usdToLocalMinor } from "./prefs";

describe("normalizePrefs", () => {
  it("gives defaults for nothing, junk or a partial blob", () => {
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs("x")).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs({ orderPanelSize: "tiny" }).orderPanelSize).toBe("tiny");
    expect(normalizePrefs({ orderPanelSize: "huge" }).orderPanelSize).toBe("comfortable");
  });
  it("keeps only known pickup minutes, sorted, once", () => {
    expect(normalizePrefs({ pickupChoices: [45, 0, 45, 7, 15] }).pickupChoices).toEqual([0, 15, 45]);
  });
  it("rejects a bad step, rate and label", () => {
    const p = normalizePrefs({ quantityStep: 7, usdRate: -3, drinkLabel: "   " });
    expect([p.quantityStep, p.usdRate, p.drinkLabel]).toEqual([0, 0, "مشروب"]);
  });
});

describe("parseTypedQuantity", () => {
  it("reads western and Arabic digits, 1 to 999", () => {
    expect(parseTypedQuantity("10")).toBe(10);
    expect(parseTypedQuantity(" ١٢ ")).toBe(12);
    expect(parseTypedQuantity("0")).toBeNull();
    expect(parseTypedQuantity("1000")).toBeNull();
    expect(parseTypedQuantity("2.5")).toBeNull();
    expect(parseTypedQuantity("")).toBeNull();
  });
});

describe("billItemName", () => {
  const on = { drinkLabelOn: true, drinkLabel: "مشروب", drinkCategories: ["مشروبات"] };
  it("renames only chosen categories, only when on", () => {
    expect(billItemName("كوكا كولا", "مشروبات", on)).toBe("مشروب");
    expect(billItemName("برغر", "وجبات", on)).toBe("برغر");
    expect(billItemName("كوكا كولا", "مشروبات", { ...on, drinkLabelOn: false })).toBe("كوكا كولا");
  });
});

describe("misc", () => {
  it("labels pickup choices", () => {
    expect(pickupChoiceLabel(0)).toBe("فوراً");
    expect(pickupChoiceLabel(30)).toBe("بعد 30 د");
  });
  it("converts dollars at the owner's rate", () => {
    expect(usdToLocalMinor(12.5, 15000, 1)).toBe(187500);
    expect(usdToLocalMinor(1, 0, 1)).toBe(0);
  });
});
