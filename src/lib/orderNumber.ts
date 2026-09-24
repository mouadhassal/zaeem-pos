// Short human-facing order number for tickets, receipts and the KDS.
// Order ids are UUIDv7: the FIRST hex digits are a millisecond timestamp,
// so `id.slice(0, 8)` gave every order placed within ~65 seconds the SAME
// number (two different takeaway tickets both "01a0cf8c" in the kitchen).
// The last 6 digits are random -- unique for any realistic day of orders.
export function orderNo(id: string): string {
  return id.replace(/-/g, "").slice(-6).toUpperCase();
}
