// Mirrors repo.rs `reorder_quantity`: restock to max(2 x min, min + 1).
export function reorderQuantity(currentStock: number, minStock: number): number {
  const target = Math.max(2 * minStock, minStock + 1);
  return Math.ceil(Math.max(target - Math.max(currentStock, 0), 1));
}
