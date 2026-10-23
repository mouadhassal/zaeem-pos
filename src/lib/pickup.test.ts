import { describe, expect, it } from "vitest";
import { pickupAtFromClock, pickupAtFromMinutes, pickupCountdown, pickupKitchenLabel } from "./pickup";
import { kitchenTicketRows } from "./ticketLayout";

const MIN = 60_000;
// 2026-10-23 18:00:20 local time.
const NOW = new Date(2026, 9, 23, 18, 0, 20).getTime();

describe("pickup time", () => {
  it("rounds a quick choice up to the whole minute", () => {
    expect(pickupAtFromMinutes(NOW, 20)).toBe(new Date(2026, 9, 23, 18, 21, 0).getTime());
  });

  it("reads a typed clock time as today, or tomorrow once it has passed", () => {
    expect(pickupAtFromClock(NOW, "19:40")).toBe(new Date(2026, 9, 23, 19, 40).getTime());
    expect(pickupAtFromClock(NOW, "17:55")).toBe(new Date(2026, 9, 23, 17, 55).getTime());
    expect(pickupAtFromClock(NOW, "00:15")).toBe(new Date(2026, 9, 24, 0, 15).getTime());
    expect(pickupAtFromClock(NOW, "25:00")).toBeNull();
    expect(pickupAtFromClock(NOW, "abc")).toBeNull();
  });

  it("counts down and says when the customer is late", () => {
    expect(pickupCountdown(NOW, NOW + 12 * MIN)).toEqual({ label: "بعد 12 د", late: false });
    expect(pickupCountdown(NOW, NOW + 95 * MIN)).toEqual({ label: "بعد 1 س 35 د", late: false });
    expect(pickupCountdown(NOW, NOW)).toEqual({ label: "الآن", late: false });
    expect(pickupCountdown(NOW, NOW - 5 * MIN)).toEqual({ label: "متأخر 5 د", late: true });
  });

  it("names the kitchen state", () => {
    expect(pickupKitchenLabel({ kitchen_sent: true, kitchen_at_ms: 0, kitchen_status: "READY" })).toEqual({ label: "جاهز", ready: true });
    expect(pickupKitchenLabel({ kitchen_sent: true, kitchen_at_ms: 0, kitchen_status: "PREPARING" }).label).toBe("قيد التحضير");
    expect(pickupKitchenLabel({ kitchen_sent: true, kitchen_at_ms: 0, kitchen_status: "PENDING" }).label).toBe("بانتظار المطبخ");
    expect(pickupKitchenLabel({ kitchen_sent: false, kitchen_at_ms: NOW, kitchen_status: "PENDING" }).label).toMatch(/^للمطبخ الساعة /);
  });

  it("prints the pickup time big on the kitchen slip", () => {
    const rows = kitchenTicketRows({
      tableName: "", orderNumber: "A12", orderType: "TAKEAWAY", customerName: "سامر",
      items: [{ name: "برغر", quantity: 2 }], pickupAt: new Date(NOW + 20 * MIN).toISOString(),
    }, new Date(NOW));
    const pickup = rows.find((r) => r.t === "line" && r.text.startsWith("استلام الساعة"));
    expect(pickup).toMatchObject({ bold: true, size: 34 });
    expect(rows.some((r) => r.t === "two" && r.right === "العميل" && r.left === "سامر")).toBe(true);
  });
});
