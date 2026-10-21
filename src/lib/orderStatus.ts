/** Arabic label for an order's status (orders.status CHECK list). Unknown values pass through. */
const ORDER_STATUS_AR: Record<string, string> = {
  DRAFT: "مسودة",
  PENDING: "مفتوح",
  PREPARING: "قيد التحضير",
  READY: "جاهز",
  SERVED: "مُقدَّم",
  PAID: "مدفوع",
  CANCELLED: "ملغي",
  SCHEDULED: "مجدول",
  VOIDED: "ملغى",
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_AR[status] ?? status;
}
