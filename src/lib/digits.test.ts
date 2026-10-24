import { describe, expect, it } from "vitest";
import { toLatinDigits } from "./digits";

describe("toLatinDigits", () => {
  it("converts Arabic-Indic digits", () => {
    expect(toLatinDigits("٧٥٠٠")).toBe("7500");
    expect(toLatinDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  it("converts Persian digits and the Arabic decimal point", () => {
    expect(toLatinDigits("۱۲۳")).toBe("123");
    expect(toLatinDigits("١٢٫٥")).toBe("12.5");
  });

  it("leaves letters and Latin digits alone", () => {
    expect(toLatinDigits("طاولة ٣ - T4")).toBe("طاولة 3 - T4");
    expect(toLatinDigits("7500")).toBe("7500");
  });
});
