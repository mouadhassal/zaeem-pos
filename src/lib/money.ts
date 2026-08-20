// Currency-aware money formatting. Mirrors src-tauri/src/money.rs's
// MoneyPolicy::scale_for exactly -- must stay in sync with that match arm,
// not diverge with its own rules. SYP/IQD have scale 0 (every *_cents
// column already stores a whole major-unit amount, not a minor unit, for
// those currencies specifically -- do NOT add a blanket ×100/÷100
// conversion; that was the root cause of the old "two extra zeros" bug).
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

export function scaleFor(currency: string): number {
  switch (currency) {
    case "SYP":
    case "IQD":
      return 0;
    case "KWD":
    case "BHD":
    case "OMR":
    case "JOD":
      return 3;
    // SAR, USD, AED, QAR, EGP, LBP, SDG, and anything unrecognized: ISO 4217 default.
    default:
      return 2;
  }
}

// Module-level "current tenant currency", set once chain_config.currency is
// known (see taxCalculator.ts::getDefaultTaxConfig, settings/page.tsx,
// pos/page.tsx) -- every formatMoney()/parseMoneyInput() call without an
// explicit currency argument uses this. Defaults to SYP so behavior is
// unchanged before the first config fetch resolves (matches the app's
// only-ever-shipped tenant currency today).
let currentCurrency = "SYP";

export function setCurrency(currency: string): void {
  if (!currency) return;
  currentCurrency = currency;
  CURRENCY_SYMBOL = CURRENCY_SYMBOLS[currency] || currency;
}

export function getCurrency(): string {
  return currentCurrency;
}

// Live binding -- reassigned by setCurrency(), so existing `import {
// CURRENCY_SYMBOL }` call sites (settings/page.tsx's static labels) pick up
// the real tenant currency's symbol with no call-site changes needed.
export let CURRENCY_SYMBOL = CURRENCY_SYMBOLS[currentCurrency];

export function formatMoney(amountCents: number, currency: string = currentCurrency): string {
  const scale = scaleFor(currency);
  const symbol = CURRENCY_SYMBOLS[currency] || currency;
  const amount = amountCents / 10 ** scale;
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  });
  return `${formatted} ${symbol}`;
}

export function parseMoneyInput(value: string, currency: string = currentCurrency): number {
  const scale = scaleFor(currency);
  const parsed = parseFloat(value) || 0;
  return Math.round(parsed * 10 ** scale);
}
