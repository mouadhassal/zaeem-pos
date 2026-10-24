// What a refund will give back, shown before the manager confirms. The
// main terminal computes the real amount (src-tauri/src/order_history.rs's
// refund_amount, called by Repo::refund_order); this mirrors it line for
// line so the number on screen is the number that comes out of the drawer.

export interface RefundableLine {
  id: string;
  quantity: number;
  /** Price plus options, for one. */
  unitValueCents: number;
  refundedQuantity: number;
  comped: boolean;
}

/**
 * Each line's share of what the customer really paid for the items
 * (discount, tax and service included, delivery fee excluded), rounded half
 * up. The refund that takes the last chargeable item returns everything
 * still unrefunded. Never more than what is left.
 */
export function refundAmount(
  linesValue: number,
  grossItemsValue: number,
  totalCents: number,
  deliveryFeeCents: number,
  alreadyRefunded: number,
  takesLastItem: boolean,
): number {
  const remaining = Math.max(0, totalCents - alreadyRefunded);
  if (takesLastItem) return remaining;
  if (grossItemsValue <= 0) return 0;
  const paidForItems = Math.max(0, totalCents - deliveryFeeCents);
  const share = Math.floor((linesValue * paidForItems * 2 + grossItemsValue) / (2 * grossItemsValue));
  return Math.min(share, remaining);
}

/** `take` maps line id to quantity; "ALL" is the whole order. */
export function refundPreview(
  lines: readonly RefundableLine[],
  take: Readonly<Record<string, number>> | "ALL",
  totalCents: number,
  deliveryFeeCents: number,
  alreadyRefunded: number,
): number {
  const chargeable = lines.filter((l) => !l.comped);
  const gross = chargeable.reduce((s, l) => s + l.unitValueCents * l.quantity, 0);
  if (take === "ALL") return Math.max(0, totalCents - alreadyRefunded);
  let value = 0;
  for (const l of chargeable) value += l.unitValueCents * (take[l.id] ?? 0);
  if (value <= 0) return 0;
  const takesLast = chargeable.every((l) => l.refundedQuantity + (take[l.id] ?? 0) >= l.quantity);
  return refundAmount(value, gross, totalCents, deliveryFeeCents, alreadyRefunded, takesLast);
}
