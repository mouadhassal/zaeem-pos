import { useState, useEffect } from "react";
import { getDb } from "../db";

const CURRENCY_SYMBOLS: Record<string, string> = {
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
    getDb()
      .then((db) =>
        db
          .selectFrom("chain_config")
          .select("currency")
          .where("id", "=", "default")
          .executeTakeFirst()
      )
      .then((row) => {
        if (row?.currency) setCurrency(row.currency);
      })
      .catch(() => {});
  }, []);

  const symbol = CURRENCY_SYMBOLS[currency] || currency;
  const fmt = (cents: number) => `${(cents / 100).toFixed(2)} ${symbol}`;

  return { currency, symbol, fmt };
}
