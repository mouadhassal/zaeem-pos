import { describe, expect, it } from "vitest";
import { pinKeyDigit } from "./usePinKeyboard";

describe("pinKeyDigit", () => {
  it("takes the top row and numpad digits", () => {
    expect(pinKeyDigit("0")).toBe("0");
    expect(pinKeyDigit("7")).toBe("7");
  });
  it("takes Arabic-Indic and Persian digits typed on an Arabic keyboard", () => {
    expect(pinKeyDigit("٣")).toBe("3");
    expect(pinKeyDigit("۹")).toBe("9");
  });
  it("ignores everything else", () => {
    for (const k of ["a", "Enter", "Backspace", " ", "10", "", "ا"]) expect(pinKeyDigit(k)).toBeNull();
  });
});
