import { CURRENCY_SYMBOL, formatMoney } from "../lib/money";

// Pre-existing gap fixed 2026-08-18: `pos/page.tsx` already imported this
// (keyed lookup by `cfg.currency` from `get_receipt_config_v3`) but it was
// never actually exported anywhere, a `tsc --noEmit` failure. Currency
// codes match `src-tauri/src/money.rs`'s `scale_for` match arms; codes not
// listed here fall back to the raw currency code itself (see call site).
export const CURRENCY_SYMBOLS: Record<string, string> = {
  SYP: "ل.س",
  IQD: "د.ع",
  USD: "$",
  EUR: "€",
  SAR: "ر.س",
  KWD: "د.ك",
  BHD: "د.ب",
  OMR: "ر.ع",
  JOD: "د.أ",
};

export function useCurrency() {
  return { currency: "SYP", symbol: CURRENCY_SYMBOL, fmt: formatMoney };
}
