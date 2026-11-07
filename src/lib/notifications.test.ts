import { describe, expect, it } from "vitest";
import { longShiftNotification, lowIngredientNotifications, lowProductNotifications, visibleNotifications } from "./notifications";

describe("notifications", () => {
  it("says which products ran out and which are about to, emptiest first", () => {
    const n = lowProductNotifications([
      { menu_item_id: "a", name: "بسكويت", quantity: 4, min_quantity: 6 },
      { menu_item_id: "b", name: "شاي", quantity: 0, min_quantity: 2 },
      { menu_item_id: "c", name: "جبنة", quantity: 0.5, min_quantity: 1, sold_by: "weight" },
    ], "2026-11-05");
    expect(n.map((x) => x.title)).toEqual(["شاي نفد", "جبنة أوشك على النفاد", "بسكويت أوشك على النفاد"]);
    expect(n[1]!.detail).toContain("0.5 كغ");
    expect(n.every((x) => x.view === "stockroom")).toBe(true);
  });

  it("folds a long list into a count instead of flooding the bell", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ menu_item_id: `p${i}`, name: `منتج ${i}`, quantity: i, min_quantity: 20 }));
    const n = lowProductNotifications(rows, "2026-11-05", 5);
    expect(n).toHaveLength(6);
    expect(n[5]!.title).toBe("و7 منتجات أخرى أوشكت على النفاد");
  });

  it("covers kitchen ingredients with their unit", () => {
    const n = lowIngredientNotifications([{ id: "i1", name: "طحين", unit: "كغ", current_stock: 3, min_stock: 10 }], "2026-11-05");
    expect(n[0]!.detail).toBe("المتبقي 3 كغ (الحد الأدنى 10)");
    expect(n[0]!.view).toBe("inventory");
  });

  it("flags a shift left open too long, and nothing for a normal one", () => {
    const now = Date.parse("2026-11-05T20:00:00Z");
    expect(longShiftNotification("2026-11-05T12:00:00Z", now, "2026-11-05")).toBeNull();
    const n = longShiftNotification("2026-11-04T20:00:00Z", now, "2026-11-05");
    expect(n?.detail).toContain("24 ساعة");
    expect(longShiftNotification(null, now, "2026-11-05")).toBeNull();
    expect(longShiftNotification("garbage", now, "2026-11-05")).toBeNull();
  });

  it("hides what was dismissed; a new day brings it back", () => {
    const [n] = lowProductNotifications([{ menu_item_id: "a", name: "x", quantity: 0, min_quantity: 1 }], "2026-11-05");
    expect(visibleNotifications([n!], [n!.id])).toHaveLength(0);
    const [next] = lowProductNotifications([{ menu_item_id: "a", name: "x", quantity: 0, min_quantity: 1 }], "2026-11-06");
    expect(visibleNotifications([next!], [n!.id])).toHaveLength(1);
  });
});
