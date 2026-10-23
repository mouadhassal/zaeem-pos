import { formatArabicTime } from "./dateLocal";

/** Quick pickup choices for a phone order, in minutes from now. */
export const PICKUP_MINUTES = [15, 20, 30, 45, 60] as const;

const MINUTE = 60_000;

/** `minutes` from now, rounded up to the whole minute so the slip reads cleanly. */
export function pickupAtFromMinutes(nowMs: number, minutes: number): number {
  return Math.ceil((nowMs + minutes * MINUTE) / MINUTE) * MINUTE;
}

/**
 * A clock time typed by the cashier ("19:40") as the next such moment: today,
 * or tomorrow when that time already passed more than 10 minutes ago (a call
 * at 23:30 for 00:15). Null for anything that is not a valid HH:MM.
 */
export function pickupAtFromClock(nowMs: number, hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date(nowMs);
  d.setHours(h, min, 0, 0);
  let at = d.getTime();
  if (at < nowMs - 10 * MINUTE) at += 24 * 60 * MINUTE;
  return at;
}

/** "بعد 12 د", "الآن", or "متأخر 5 د" (late = the customer should be here). */
export function pickupCountdown(nowMs: number, pickupAtMs: number): { label: string; late: boolean } {
  const diff = Math.round((pickupAtMs - nowMs) / MINUTE);
  if (diff > 0) return { label: diff >= 60 ? `بعد ${Math.floor(diff / 60)} س ${diff % 60} د` : `بعد ${diff} د`, late: false };
  if (diff === 0) return { label: "الآن", late: false };
  return { label: `متأخر ${-diff} د`, late: true };
}

/** Where the order is in the kitchen, in the cashier's words. */
export function pickupKitchenLabel(p: { kitchen_sent: boolean; kitchen_at_ms: number; kitchen_status: string }): { label: string; ready: boolean } {
  if (!p.kitchen_sent) return { label: `للمطبخ الساعة ${formatArabicTime(new Date(p.kitchen_at_ms))}`, ready: false };
  if (p.kitchen_status === "READY") return { label: "جاهز", ready: true };
  if (p.kitchen_status === "PREPARING") return { label: "قيد التحضير", ready: false };
  return { label: "بانتظار المطبخ", ready: false };
}
