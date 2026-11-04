import { describe, expect, it } from "vitest";
import { isTauriRuntime } from "./tauriRuntime";
import { friendlyUpdateError } from "./autoUpdate";

describe("isTauriRuntime", () => {
  it("is true in the real app, where only __TAURI_INTERNALS__ exists", () => {
    expect(isTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true);
  });
  it("is true when the global API is on too", () => {
    expect(isTauriRuntime({ __TAURI__: {} })).toBe(true);
  });
  it("is false in a plain browser", () => {
    expect(isTauriRuntime({})).toBe(false);
  });
});

describe("friendlyUpdateError", () => {
  it("says plainly when the update server cannot be reached", () => {
    expect(friendlyUpdateError("error sending request for url (https://x)")).toContain("الاتصال بخادم التحديثات");
    expect(friendlyUpdateError("failed to lookup address information")).toContain("الاتصال بخادم التحديثات");
  });
  it("explains a signature failure", () => {
    expect(friendlyUpdateError("the signature could not be verified")).toContain("التوقيع");
  });
  it("keeps any other message as it is", () => {
    expect(friendlyUpdateError("something odd")).toBe("something odd");
  });
});
