import { describe, it, expect, afterEach } from "vitest";
import { formatMoney, parseMoneyInput, scaleFor, setCurrency, getCurrency, CURRENCY_SYMBOL } from "./money";

describe("scaleFor", () => {
  it("matches src-tauri/src/money.rs::MoneyPolicy::scale_for exactly", () => {
    expect(scaleFor("SYP")).toBe(0);
    expect(scaleFor("IQD")).toBe(0);
    expect(scaleFor("KWD")).toBe(3);
    expect(scaleFor("BHD")).toBe(3);
    expect(scaleFor("OMR")).toBe(3);
    expect(scaleFor("JOD")).toBe(3);
    expect(scaleFor("USD")).toBe(2);
    expect(scaleFor("SAR")).toBe(2);
    expect(scaleFor("SOMETHING_UNKNOWN")).toBe(2);
  });
});

describe("formatMoney", () => {
  afterEach(() => setCurrency("SYP"));

  it("formats SYP (scale 0) with no decimals -- the only currency ever shipped so far", () => {
    expect(formatMoney(15000)).toBe("15,000 ل.س");
  });

  it("formats a scale-2 currency (SAR) with two decimals via an explicit currency arg", () => {
    expect(formatMoney(15000, "SAR")).toBe("150.00 ر.س");
  });

  it("formats a scale-3 currency (KWD) with three decimals", () => {
    expect(formatMoney(15000, "KWD")).toBe("15.000 د.ك");
  });

  it("falls back to the raw currency code as the symbol when unrecognized", () => {
    expect(formatMoney(1000, "XYZ")).toBe("10.00 XYZ");
  });

  it("uses setCurrency() as the default when no explicit currency is passed", () => {
    setCurrency("SAR");
    expect(getCurrency()).toBe("SAR");
    expect(formatMoney(15000)).toBe("150.00 ر.س");
    expect(CURRENCY_SYMBOL).toBe("ر.س");
  });
});

describe("parseMoneyInput", () => {
  afterEach(() => setCurrency("SYP"));

  it("round-trips a whole SYP amount with no scaling", () => {
    expect(parseMoneyInput("15000")).toBe(15000);
  });

  it("scales a SAR (2-decimal) major-unit input into minor units", () => {
    expect(parseMoneyInput("150.00", "SAR")).toBe(15000);
  });

  it("returns 0 for unparseable input", () => {
    expect(parseMoneyInput("abc")).toBe(0);
  });
});
