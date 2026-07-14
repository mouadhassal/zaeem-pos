import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("بريد إلكتروني غير صالح"),
  password: z.string().min(6, "كلمة المرور يجب أن تكون 6 أحرف على الأقل"),
});

export const orderItemSchema = z.object({
  menuItemId: z.string().uuid(),
  quantity: z.number().int().min(1, "الكمية يجب أن تكون 1 على الأقل"),
  modifiers: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        priceCents: z.number().int().min(0),
      })
    )
    .default([]),
  notes: z.string().optional(),
});

export const paymentSchema = z.object({
  method: z.enum(["cash", "card", "wallet", "credit"]),
  amountCents: z.number().int().min(1, "المبلغ يجب أن يكون أكبر من صفر"),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type OrderItemInput = z.infer<typeof orderItemSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
