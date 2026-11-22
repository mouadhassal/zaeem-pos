// Warehouses (المخازن). A shop with one store room sees nothing of this: every picker and column
// only shows once there are two shown warehouses. The numbers are worked out in
// src-tauri/src/warehouses.rs; the total of an ingredient stays `current_stock`.
// The hooks that load the data are in useWarehouses.ts.
export interface Warehouse {
  id: string;
  branch_id: string;
  name: string;
  is_default: boolean;
  active: boolean;
  sort: number;
}

/** How much of one ingredient sits in one warehouse. */
export interface StockCell {
  ingredient_id: string;
  warehouse_id: string;
  qty: number;
}

/** The warehouses people can pick (hidden ones left out). */
export function shownWarehouses(all: Warehouse[]): Warehouse[] {
  return all.filter((w) => w.active);
}

/** True once the owner has added a second warehouse. */
export function isMulti(all: Warehouse[]): boolean {
  return shownWarehouses(all).length >= 2;
}

export function warehouseQty(cells: StockCell[], ingredientId: string, warehouseId: string): number {
  return cells.find((c) => c.ingredient_id === ingredientId && c.warehouse_id === warehouseId)?.qty ?? 0;
}

/** The warehouse to send with a form: nothing chosen (or a single warehouse) means null = the default one. */
export function warehouseToSend(chosen: string): string | null {
  return chosen || null;
}
