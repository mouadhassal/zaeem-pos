// SYP has scale 0 (src-tauri/src/money.rs, MoneyPolicy::scale_for) — every
// *_cents column already stores a whole SYP amount, not a minor unit. Do
// NOT add ×100/÷100 conversions here; that was the root cause of the
// "two extra zeros" bug.
export const CURRENCY_SYMBOL = "ل.س";

export function formatMoney(amountCents: number): string {
  return `${Math.round(amountCents).toLocaleString("en-US")} ${CURRENCY_SYMBOL}`;
}

export function parseMoneyInput(value: string): number {
  return Math.round(parseFloat(value) || 0);
}
