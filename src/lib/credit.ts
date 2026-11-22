// Credit customers: types the debt statement and the customer page share, and the small pure helpers behind the
// settlement screen. The real arithmetic is in src-tauri/src/credit.rs (`allocate`); `previewGeneralPayment` repeats it
// so the screen can say where an overall payment will go, and credit.test.ts pins it to the numbers credit.rs asserts.

export interface InvoiceLine {
  entry_id: string;
  order_id: string | null;
  /** The order's number on the till ("ص-12"), when there is one. */
  order_label: string | null;
  date: string;
  amount_cents: number;
  paid_cents: number;
  remaining_cents: number;
  /** The opening balance typed when the debtor was created (no order behind it). */
  opening: boolean;
}

export interface StatementEntry {
  id: string;
  kind: "DEBT" | "PAYMENT";
  order_id: string | null;
  order_label: string | null;
  amount_cents: number;
  notes: string | null;
  created_at: string;
  balance_after_cents: number;
}

export interface DebtStatement {
  debtor_id: string;
  debtor_name: string;
  phone: string | null;
  customer_id: string | null;
  customer_name: string | null;
  balance_cents: number;
  total_debt_cents: number;
  total_paid_cents: number;
  invoices: InvoiceLine[];
  entries: StatementEntry[];
}

export interface CustomerDebt {
  customer_id: string;
  balance_cents: number;
  statements: DebtStatement[];
}

export interface DebtorLink {
  customer_id: string | null;
  customer_name: string | null;
  created: boolean;
}

/** What an invoice is called on screen. */
export function invoiceTitle(l: InvoiceLine): string {
  if (l.opening) return "رصيد سابق";
  return l.order_label ? `فاتورة ${l.order_label}` : "فاتورة";
}

/** The invoices that still have something to pay. */
export function openInvoices(lines: InvoiceLine[]): InvoiceLine[] {
  return lines.filter((l) => l.remaining_cents > 0);
}

/** An amount kept between 0 and what is left. */
export function clampSettlement(amountCents: number, remainingCents: number): number {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  return Math.min(Math.round(amountCents), Math.max(0, remainingCents));
}

/** Where an overall (not per-invoice) payment of `amountCents` goes: the oldest open invoices first. */
export function previewGeneralPayment(lines: InvoiceLine[], amountCents: number): { entry_id: string; take_cents: number }[] {
  let left = Math.max(0, amountCents);
  const out: { entry_id: string; take_cents: number }[] = [];
  for (const l of lines) {
    if (left <= 0) break;
    const take = Math.min(left, l.remaining_cents);
    if (take > 0) {
      out.push({ entry_id: l.entry_id, take_cents: take });
      left -= take;
    }
  }
  return out;
}
