import { describe, expect, it } from "vitest";
import { printableShopName } from "./shopName";

describe("printableShopName", () => {
  it("prints the shop's own name", () => {
    expect(printableShopName("مطعم الشام", "الفرع الرئيسي")).toBe("مطعم الشام");
  });
  it("never prints the old 'Zaeem POS' default: falls back to the branch name", () => {
    expect(printableShopName("Zaeem POS", "فرع المزة")).toBe("فرع المزة");
    expect(printableShopName("", "فرع المزة")).toBe("فرع المزة");
  });
});
