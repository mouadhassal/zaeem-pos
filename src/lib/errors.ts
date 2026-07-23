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
