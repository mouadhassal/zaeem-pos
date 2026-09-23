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
export function realErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
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
  const raw = realErrorText(err);
  if (/FOREIGN KEY constraint failed/i.test(raw) || /foreign key/i.test(raw)) {
    return `لا يمكن حذف ${whatArabic} لأنه مستخدم في سجلات أخرى (طلبات أو فواتير سابقة) -- يمكنك تعطيله بدلاً من حذفه.`;
  }
  return `حدث خطأ في الحذف: ${raw}`;
}
