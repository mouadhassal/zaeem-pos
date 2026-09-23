/**
 * P0 follow-up (2026-07-23): pages used to show a fixed generic Arabic
 * string on any load failure ("تعذر تحميل الطاولات من قاعدة البيانات")
 * with the real error discarded (`catch {}`), so a "database is locked"
 * vs "unable to open database file" vs anything else was indistinguishable
 * on screen. This extracts the real message from whatever `invoke()`
 * rejected with (a string, since Tauri commands return `Result<T, String>`
 * -- but `instanceof Error` is checked first for safety with anything
 * else that can throw).
 */
export function rawErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

type Localizer = string | ((m: RegExpMatchArray) => string);

// Known backend (Rust) English errors -> Arabic. Unmapped text passes through.
const BACKEND_ERRORS_AR: [RegExp, Localizer][] = [
  [/session expired/i, "انتهت الجلسة -- أدخل رمزك مجدداً"],
  [/^invalid session/i, "الجلسة غير صالحة -- سجّل الدخول مجدداً"],
  [/^forbidden \(/i, "ليست لديك صلاحية لتنفيذ هذه العملية"],
  [/^out of scope|does not belong to the caller/i, "هذا السجل لا يتبع فرعك أو منشأتك"],
  [/manager PIN is not valid/i, "رمز المدير غير صحيح"],
  [/voiding an item over the manager-override threshold requires a manager PIN/i, "إلغاء هذا الصنف يتطلب رمز المدير"],
  [/closing a shift with a discrepancy over the manager-override threshold requires a manager PIN/i, "إغلاق الوردية بهذا الفارق يتطلب رمز المدير"],
  [/^license expired/i, "انتهى الترخيص -- الإدارة مقفلة حتى التجديد، ونقطة البيع تعمل طبيعياً"],
  [/discount of (\d+)% exceeds your cap of (\d+)%/i, (m) => `الخصم ${m[1]}% يتجاوز الحد المسموح لك (${m[2]}%) -- اطلب موافقة المدير`],
  [/is already PAID/i, "هذا الطلب مدفوع مسبقاً"],
  [/shift .* is already closed/i, "هذه الوردية مغلقة مسبقاً"],
  [/order item .* is already voided/i, "هذا الصنف ملغى مسبقاً"],
  [/has a credit limit of/i, "هذا المبلغ يتجاوز سقف الدين المسموح لهذا المدين"],
  [/loyalty card .* not found/i, "بطاقة الولاء غير موجودة"],
  [/has (\d+) points, needs (\d+)/i, (m) => `رصيد النقاط غير كافٍ (${m[1]} من ${m[2]})`],
  [/is (\w+), not PENDING/i, "طلبية الشراء ليست بانتظار الاستلام"],
  [/^negative (amounts|starting cash|tax rate) (are|is) not valid|must be positive|cannot be negative|must not be negative/i, "القيمة المدخلة غير صالحة (لا يمكن أن تكون سالبة أو صفراً)"],
  [/^invalid credentials/i, "بيانات الدخول غير صحيحة"],
  [/current password is incorrect/i, "كلمة المرور الحالية غير صحيحة"],
  [/database is locked|database is busy/i, "قاعدة البيانات مشغولة حالياً -- أعد المحاولة بعد لحظات"],
];

export function localizeBackendError(raw: string): string {
  for (const [re, ar] of BACKEND_ERRORS_AR) {
    const m = raw.match(re);
    if (m) return typeof ar === "string" ? ar : ar(m);
  }
  return raw;
}

// The real backend error, in Arabic when a mapping exists (never a generic string).
export function realErrorText(err: unknown): string {
  return localizeBackendError(rawErrorText(err));
}

/** Backend NO_OPEN_SHIFT_ERR (commands/orders.rs) -- a sale needs an open shift. */
export function isNoOpenShiftError(err: unknown): boolean {
  return realErrorText(err).includes("لا توجد وردية مفتوحة");
}

/**
 * 2026-09-13 audit fix: delete_menu_item_v3/delete_category_v3/
 * delete_supplier_v3 (and friends) don't catch SQLite's FOREIGN KEY
 * constraint errors on the Rust side -- repo.rs just propagates whatever
 * rusqlite/SQLite says (e.g. "FOREIGN KEY constraint failed", or a raw
 * "UNIQUE constraint failed: ..." for other cases), and that raw
 * English/SQL text was reaching the Arabic delete-confirmation flow
 * verbatim. This recognizes the common FK-violation shape (deleting a
 * row something else still references -- an order line, a purchase,
 * a payment...) and returns one friendly Arabic sentence for it; any
 * other error still falls through to the real message via realErrorText,
 * never swallowed.
 */
export function friendlyDeleteErrorText(err: unknown, whatArabic: string): string {
  const raw = rawErrorText(err);
  if (/FOREIGN KEY constraint failed/i.test(raw) || /foreign key/i.test(raw)) {
    return `لا يمكن حذف ${whatArabic} لأنه مستخدم في سجلات أخرى (طلبات أو فواتير سابقة) -- يمكنك تعطيله بدلاً من حذفه.`;
  }
  return `حدث خطأ في الحذف: ${localizeBackendError(raw)}`;
}
