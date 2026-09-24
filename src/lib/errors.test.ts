import { describe, it, expect } from "vitest";
import { realErrorText, localizeBackendError, isNoOpenShiftError, friendlyDeleteErrorText } from "./errors";

describe("realErrorText", () => {
  it("localizes known backend errors", () => {
    expect(realErrorText("manager PIN is not valid")).toBe("رمز المدير غير صحيح");
    expect(realErrorText(new Error("forbidden (ManageSettings): rank too low"))).toBe("ليست لديك صلاحية لتنفيذ هذه العملية");
    expect(realErrorText("discount of 37% exceeds your cap of 10% -- ask a manager for an override")).toContain("37%");
    expect(realErrorText("shift abc is already closed -- refusing to overwrite its reconciliation numbers")).toBe("هذه الوردية مغلقة مسبقاً");
  });

  it("passes unknown errors through verbatim instead of a generic message", () => {
    expect(realErrorText("unable to open database file")).toBe("unable to open database file");
    expect(localizeBackendError("لا توجد وردية مفتوحة -- يجب فتح وردية أولاً قبل البيع")).toContain("وردية");
  });

  it("detects the no-open-shift error", () => {
    expect(isNoOpenShiftError("لا توجد وردية مفتوحة -- يجب فتح وردية أولاً قبل البيع")).toBe(true);
    expect(isNoOpenShiftError("manager PIN is not valid")).toBe(false);
  });

  it("keeps the FK delete mapping", () => {
    expect(friendlyDeleteErrorText("FOREIGN KEY constraint failed", "المورد")).toContain("لا يمكن حذف المورد");
  });
});
