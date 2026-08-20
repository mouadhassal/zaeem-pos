import { CURRENCY_SYMBOL, CURRENCY_SYMBOLS, formatMoney, getCurrency } from "../lib/money";

// Re-exported for the few call sites that import CURRENCY_SYMBOLS from
// here rather than from lib/money directly.
export { CURRENCY_SYMBOLS };

export function useCurrency() {
  return { currency: getCurrency(), symbol: CURRENCY_SYMBOL, fmt: formatMoney };
}
