import { useState, useEffect } from "react";
import { invoke } from "../lib/invoke";
import { useAuthStore } from "../stores/authStore";

export const CURRENCY_SYMBOLS: Record<string, string> = {
  SAR: "ر.س",
  SYP: "ل.س",
  IQD: "د.ع",
  JOD: "د.ا",
  USD: "$",
  AED: "د.إ",
  QAR: "ر.ق",
  KWD: "د.ك",
  BHD: "د.ب",
  OMR: "ر.ع",
  EGP: "ج.م",
  LBP: "ل.ل",
  SDG: "ج.س",
};

const DEFAULT_CURRENCY = "SAR";

export function useCurrency() {
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);

  useEffect(() => {
    const token = useAuthStore.getState().token;
    invoke<{ currency: string }>("get_chain_config_v3", { sessionToken: token })
      .then((row) => {
        if (row?.currency) setCurrency(row.currency);
      })
      .catch(() => {});
  }, []);

  const symbol = CURRENCY_SYMBOLS[currency] || currency;
  const fmt = (cents: number) => `${(cents / 100).toFixed(2)} ${symbol}`;

  return { currency, symbol, fmt };
}
