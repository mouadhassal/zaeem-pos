// Kitchen station printing: which kitchen printer gets which items.
//
// A big kitchen has one printer per station (grill, fryer, bar...). Each
// KITCHEN printer can be given menu categories in Settings:
//   * a printer WITH categories prints only the items of those categories;
//   * a printer with NONE prints the whole ticket (what every kitchen
//     printer did before stations existed; also what a pass/expo printer
//     wants), so existing setups behave exactly as they did.
// An item is never dropped: if no printer claims its category and no printer
// prints everything, it goes to the first printer.

export interface RoutePrinter {
  id: string;
  /** Empty = prints every item. */
  categoryIds: readonly string[];
}

export function routeKitchenItems<T extends { menuItemId?: string }>(
  items: readonly T[],
  printers: readonly RoutePrinter[],
  categoryOf: (menuItemId: string | undefined) => string | undefined
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  const first = printers[0];
  if (!first) return out;
  const fullPrinters = printers.filter((p) => p.categoryIds.length === 0);

  for (const item of items) {
    const category = categoryOf(item.menuItemId);
    const stations = category ? printers.filter((p) => p.categoryIds.includes(category)) : [];
    let targets = [...stations, ...fullPrinters.filter((p) => !stations.includes(p))];
    if (targets.length === 0) targets = [first];
    for (const printer of targets) {
      const list = out.get(printer.id) ?? [];
      list.push(item);
      out.set(printer.id, list);
    }
  }
  return out;
}
