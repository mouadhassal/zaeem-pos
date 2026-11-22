import { describe, expect, it } from "vitest";
import { TERMS, TERM_KEYS, labelNav, termsFor, termsType } from "./terms";
import { localizeText, chaptersFor } from "./guide";
import type { BusinessType } from "./businessModules";

const TYPES: BusinessType[] = ["restaurant", "cafe", "shop", "supplier"];
const nav = ["pos", "orders", "customers", "menu", "kds", "ai-onboarding", "reports"].map((id) => ({ id, label: id, icon: "x", allowed: true }));

describe("terms", () => {
  it("every type has every key, none empty", () => {
    for (const type of TYPES) {
      const t = termsFor(type);
      expect(Object.keys(t).sort(), type).toEqual([...TERM_KEYS].sort());
      for (const key of TERM_KEYS) expect(t[key].trim().length, `${type}.${key}`).toBeGreaterThan(0);
    }
  });

  it("the catalogue is named after the business", () => {
    expect(TERMS.restaurant.menu).toBe("القائمة");
    expect(TERMS.cafe.menu).toBe("القائمة");
    expect(TERMS.shop.menu).toBe("المنتجات");
    expect(TERMS.supplier.menu).toBe("قائمة الأسعار");
    expect(TERMS.shop.item).toBe("منتج");
    expect(TERMS.supplier.item).toBe("مادة");
    expect(TERMS.supplier.customer).toBe("عميل تاجر");
  });

  it("a cafe is a restaurant with the cafe named", () => {
    expect(TERMS.cafe.place).toBe("المقهى");
    expect(TERMS.cafe.dineIn).toBe("داخل المقهى");
    expect(TERMS.cafe.menu).toBe(TERMS.restaurant.menu);
    expect(TERMS.cafe.table).toBe(TERMS.restaurant.table);
    expect(TERMS.restaurant.place).toBe("المطعم");
  });

  it("a shop or supplier never gets a restaurant as its example name", () => {
    expect(TERMS.shop.placeNameExample).not.toContain("مطعم");
    expect(TERMS.supplier.placeNameExample).not.toContain("مطعم");
    expect(TERMS.supplier.startHint).toContain("Excel");
  });

  it("the saved type wins; an install that never chose keeps what it showed", () => {
    expect(termsType("cafe", false, false)).toBe("cafe");
    expect(termsType(null, true, false)).toBe("restaurant");
    expect(termsType(null, false, false)).toBe("shop");
    expect(termsType(null, false, true)).toBe("supplier");
    expect(termsType("bogus", true, false)).toBe("restaurant");
  });

  it("the sidebar is labelled with the business's words", () => {
    const labels = (type: BusinessType) => Object.fromEntries(labelNav(nav, termsFor(type)).map((n) => [n.id, n.label]));
    expect(labels("restaurant")).toMatchObject({ pos: "نقاط البيع", orders: "سجل الطلبات", customers: "العملاء", menu: "القائمة", kds: "المطبخ", "ai-onboarding": "إعداد القائمة AI", reports: "reports" });
    expect(labels("shop")).toMatchObject({ menu: "المنتجات", orders: "سجل المبيعات", "ai-onboarding": "إعداد المنتجات AI" });
    expect(labels("supplier")).toMatchObject({ menu: "قائمة الأسعار", customers: "العملاء التجار", orders: "سجل الفواتير", "ai-onboarding": "إعداد قائمة الأسعار AI" });
  });
});

describe("guide wording", () => {
  it("names the pages the business really has", () => {
    const s = TERMS.supplier;
    expect(localizeText("افتح «القائمة ← الإضافات» ثم «العملاء» و«سجل الطلبات ← طباعة نسخة»", s)).toBe("افتح «قائمة الأسعار ← الإضافات» ثم «العملاء التجار» و«سجل الفواتير ← طباعة نسخة»");
    expect(localizeText("القائمة الرئيسية", s)).toBe("القائمة الرئيسية");
    expect(localizeText("افتح «القائمة»", TERMS.restaurant)).toBe("افتح «القائمة»");
  });

  it("chapters are localized only when asked", () => {
    const plain = JSON.stringify(chaptersFor("OWNER", false));
    const shop = JSON.stringify(chaptersFor("OWNER", false, TERMS.shop));
    expect(plain).toContain("«القائمة");
    expect(shop).not.toContain("«القائمة");
    expect(shop).toContain("«المنتجات");
  });
});
