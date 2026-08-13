import { describe, it, expect } from "vitest";
import { loginSchema, orderItemSchema, paymentSchema } from "./validation";

describe("loginSchema", () => {
  it("accepts a valid email/password", () => {
    expect(loginSchema.safeParse({ email: "a@b.com", password: "123456" }).success).toBe(true);
  });

  it("rejects an invalid email", () => {
    expect(loginSchema.safeParse({ email: "not-an-email", password: "123456" }).success).toBe(false);
  });

  it("rejects a password under 6 characters", () => {
    expect(loginSchema.safeParse({ email: "a@b.com", password: "12345" }).success).toBe(false);
  });
});

describe("orderItemSchema", () => {
  const VALID_ID = "11111111-1111-1111-1111-111111111111";

  it("accepts a minimal valid item and defaults modifiers to an empty array", () => {
    const result = orderItemSchema.safeParse({ menuItemId: VALID_ID, quantity: 1 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.modifiers).toEqual([]);
  });

  it("rejects a non-uuid menuItemId", () => {
    expect(orderItemSchema.safeParse({ menuItemId: "not-a-uuid", quantity: 1 }).success).toBe(false);
  });

  it("rejects zero or negative quantity", () => {
    expect(orderItemSchema.safeParse({ menuItemId: VALID_ID, quantity: 0 }).success).toBe(false);
    expect(orderItemSchema.safeParse({ menuItemId: VALID_ID, quantity: -1 }).success).toBe(false);
  });

  it("rejects a non-integer quantity", () => {
    expect(orderItemSchema.safeParse({ menuItemId: VALID_ID, quantity: 1.5 }).success).toBe(false);
  });

  it("rejects a modifier with a negative price", () => {
    const result = orderItemSchema.safeParse({
      menuItemId: VALID_ID,
      quantity: 1,
      modifiers: [{ id: "m1", name: "extra cheese", priceCents: -100 }],
    });
    expect(result.success).toBe(false);
  });
});

describe("paymentSchema", () => {
  it("accepts each of the four real payment methods", () => {
    for (const method of ["cash", "card", "wallet", "credit"] as const) {
      expect(paymentSchema.safeParse({ method, amountCents: 1000 }).success).toBe(true);
    }
  });

  it("rejects a method outside the enum", () => {
    expect(paymentSchema.safeParse({ method: "bitcoin", amountCents: 1000 }).success).toBe(false);
  });

  it("rejects a zero or negative amount", () => {
    expect(paymentSchema.safeParse({ method: "cash", amountCents: 0 }).success).toBe(false);
    expect(paymentSchema.safeParse({ method: "cash", amountCents: -500 }).success).toBe(false);
  });
});
