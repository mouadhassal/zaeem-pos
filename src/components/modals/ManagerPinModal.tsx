import { useState } from "react";
import { IconBackspace, IconX } from "@tabler/icons-react";
import { getDb } from "../../db";
import { verifyPassword } from "../../lib/auth";

interface Props {
  title: string;
  description: string;
  onSuccess: () => void;
  onCancel: () => void;
}

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 5 * 60;
const FAILURES_KEY = "manager_pin_failures";
const LOCKED_UNTIL_KEY = "manager_pin_locked_until";

export default function ManagerPinModal({
  title,
  description,
  onSuccess,
  onCancel,
}: Props) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);

  const remainingLockSeconds = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000)) : 0;

  const handleVerify = async () => {
    setLoading(true);
    setError(null);

    try {
      const db = await getDb();

      const lockRow = await db
        .selectFrom("app_settings")
        .select("value")
        .where("key", "=", LOCKED_UNTIL_KEY)
        .executeTakeFirst();
      const lockedUntilMs = lockRow ? parseInt(lockRow.value, 10) : 0;
      if (lockedUntilMs && Date.now() < lockedUntilMs) {
        setLockedUntil(lockedUntilMs);
        setError("تم قفل إدخال كلمة المرور بسبب كثرة المحاولات الخاطئة");
        setLoading(false);
        return;
      }
      if (lockedUntilMs && Date.now() >= lockedUntilMs) {
        await db.deleteFrom("app_settings").where("key", "=", LOCKED_UNTIL_KEY).execute();
        await db.deleteFrom("app_settings").where("key", "=", FAILURES_KEY).execute();
        setLockedUntil(null);
      }

      const manager = await db
        .selectFrom("users")
        .select(["password_hash"])
        .where("role", "in", ["MANAGER", "ADMIN", "OWNER"])
        .where("is_active", "=", 1)
        .executeTakeFirst();

      if (!manager) {
        setError("لا يوجد مدير متاح");
        setLoading(false);
        return;
      }

      const valid = await verifyPassword(pin, manager.password_hash);
      if (!valid) {
        const failuresRow = await db
          .selectFrom("app_settings")
          .select("value")
          .where("key", "=", FAILURES_KEY)
          .executeTakeFirst();
        const failures = (failuresRow ? parseInt(failuresRow.value, 10) : 0) + 1;

        if (failures >= MAX_ATTEMPTS) {
          const until = Date.now() + LOCKOUT_SECONDS * 1000;
          await db
            .insertInto("app_settings")
            .values({ key: LOCKED_UNTIL_KEY, value: String(until) })
            .onConflict((oc) => oc.column("key").doUpdateSet({ value: String(until) }))
            .execute();
          await db
            .insertInto("app_settings")
            .values({ key: FAILURES_KEY, value: "0" })
            .onConflict((oc) => oc.column("key").doUpdateSet({ value: "0" }))
            .execute();
          setLockedUntil(until);
          setError("تم قفل إدخال كلمة المرور بسبب كثرة المحاولات الخاطئة");
        } else {
          await db
            .insertInto("app_settings")
            .values({ key: FAILURES_KEY, value: String(failures) })
            .onConflict((oc) => oc.column("key").doUpdateSet({ value: String(failures) }))
            .execute();
          setError(`كلمة المرور غير صحيحة (محاولة ${failures} من ${MAX_ATTEMPTS})`);
        }
        setLoading(false);
        return;
      }

      await db.deleteFrom("app_settings").where("key", "=", FAILURES_KEY).execute();
      await db.deleteFrom("app_settings").where("key", "=", LOCKED_UNTIL_KEY).execute();
      onSuccess();
    } catch {
      setError("حدث خطأ");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-[60]"
      dir="rtl"
    >
      <div className="bg-surface rounded-2xl border border-ink-600 w-[380px] overflow-hidden">
        <div className="px-6 py-4 border-b border-ink-200">
          <h3 className="font-arabic font-bold text-lg text-ink-900">{title}</h3>
          <p className="font-arabic text-sm text-ink-400 mt-1">{description}</p>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="font-arabic text-sm text-ink-500 mb-1.5 block">
              كلمة مرور المدير
            </label>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleVerify();
              }}
              className="w-full h-12 text-center font-mono text-lg bg-surface border-2 border-ink-200 rounded-xl outline-none focus:border-accent transition-all"
              autoFocus
              dir="ltr"
            />
          </div>

          {error && (
            <p className="text-danger text-sm text-center font-arabic">{error}</p>
          )}

          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button
                key={n}
                onClick={() => setPin((p) => p + n)}
                className="h-12 rounded-xl bg-surface border border-ink-200 font-mono text-lg font-bold text-ink-900 hover:bg-ink-100 active:bg-ink-100 transition-colors"
              >
                {n}
              </button>
            ))}
            <button
              onClick={() => setPin((p) => p.slice(0, -1))}
              className="h-12 rounded-xl bg-surface border border-ink-200 text-ink-500 hover:bg-ink-100 flex items-center justify-center transition-colors"
            >
              <IconBackspace className="w-5 h-5" stroke={1.75} />
            </button>
            <button
              onClick={() => setPin((p) => p + "0")}
              className="h-12 rounded-xl bg-surface border border-ink-200 font-mono text-lg font-bold text-ink-900 hover:bg-ink-100 transition-colors"
            >
              0
            </button>
            <button
              onClick={() => setPin("")}
              className="h-12 rounded-xl bg-surface border border-ink-200 text-ink-500 hover:bg-ink-100 flex items-center justify-center transition-colors"
            >
              <IconX className="w-4 h-4" stroke={1.75} />
            </button>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-ink-200 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 h-12 rounded-xl bg-surface text-ink-900 font-arabic font-bold hover:bg-ink-200 transition-colors"
          >
            إلغاء
          </button>
          <button
            onClick={handleVerify}
            disabled={loading || pin.length < 4 || remainingLockSeconds > 0}
            className="flex-1 h-12 rounded-xl bg-accent text-white font-arabic font-bold hover:bg-accent-text shadow-sh-3 disabled:opacity-50 transition-all"
          >
            {remainingLockSeconds > 0
              ? `مقفل (${Math.ceil(remainingLockSeconds / 60)} د)`
              : loading ? "جاري..." : "تأكيد"}
          </button>
        </div>
      </div>
    </div>
  );
}
