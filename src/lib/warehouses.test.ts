import { describe, expect, it } from "vitest";
import { isMulti, shownWarehouses, warehouseQty, warehouseToSend, type StockCell, type Warehouse } from "./warehouses";

const w = (id: string, active = true, is_default = false): Warehouse => ({ id, branch_id: "b", name: id, is_default, active, sort: 0 });

describe("warehouses", () => {
  it("one warehouse is not multi, two shown ones are", () => {
    expect(isMulti([])).toBe(false);
    expect(isMulti([w("main", true, true)])).toBe(false);
    expect(isMulti([w("main", true, true), w("cold")])).toBe(true);
  });

  it("a hidden warehouse does not count", () => {
    const all = [w("main", true, true), w("old", false)];
    expect(isMulti(all)).toBe(false);
    expect(shownWarehouses(all).map((x) => x.id)).toEqual(["main"]);
  });

  it("reads one cell, 0 when there is none", () => {
    const cells: StockCell[] = [{ ingredient_id: "a", warehouse_id: "main", qty: 6 }, { ingredient_id: "a", warehouse_id: "cold", qty: 4 }];
    expect(warehouseQty(cells, "a", "cold")).toBe(4);
    expect(warehouseQty(cells, "b", "cold")).toBe(0);
  });

  it("sends nothing when nothing was chosen", () => {
    expect(warehouseToSend("")).toBeNull();
    expect(warehouseToSend("cold")).toBe("cold");
  });
});
