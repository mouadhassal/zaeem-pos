import { useState } from "react";
import { IconBackspace, IconX } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";

interface Props {
  title: string;
  description: string;
  /** Receives the verified PIN so callers that need to re-present it as a
   * manager-override proof (e.g. an over-cap discount) can forward it --
   * this modal's own `verify_manager_override_v3` call is a UX pre-check,
   * not the authorization itself; the command that actually needs the
   * override re-verifies the PIN server-side when the action is taken. */
  onSuccess: (pin: string) => void;
  onCancel: () => void;
}

export default function ManagerPinModal({
  title,
  description,
  onSuccess,
  onCancel,
}: Props) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Single sanitizer for both input sources (the typeable field and the
  // on-screen numpad grid) so there's exactly one code path mutating `pin`
  // -- previously the grid buttons appended digits with their own char-
  // append logic while the input regex-sanitized independently, which
  // could silently diverge if either path ever changed.
  const setDigits = (next: string) => setPin(next.replace(/\D/g, "").slice(0, 6));

  const handleVerify = async () => {
    setLoading(true);
    setError(null);

    try {
      // `verify_manager_override_v3` runs the comparison in Rust against
      // `staff` (never `users`, which Decision A dropped) -- the
      // password/PIN hash never reaches this renderer at all. It also now
      // owns the failure-count/lockout bookkeeping server-side (previously
      // a client-side `app_settings` read via the old Kysely helper, trivially
      // bypassable by clearing local state) and audits a successful grant.
      const token = useAuthStore.getState().token;
      await invoke<boolean>("verify_manager_override_v3", { sessionToken: token, passwordOrPin: pin });
      onSuccess(pin);
    } catch (err) {
      const msg = typeof err === "string" ? err : (err as Error)?.message ?? "";
      if (msg.includes("ECONNREFUSED") || msg.includes("network") || msg.includes("fetch")) {
        setError("خطأ في الاتصال بالخادم");
      } else {
        setError("كلمة المرور غير صحيحة، أو تم قفل الإدخال بسبب كثرة المحاولات الخاطئة");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-[60]"
      dir="rtl"
    >
      <div className="bg-white rounded-md border border-line shadow-sh-3 w-[380px] overflow-hidden">
        <div className="px-6 py-4 border-b border-ink-200 flex items-center justify-between">
          <div>
            <h3 className="font-arabic font-bold text-lg text-ink-900">{title}</h3>
            <p className="font-arabic text-sm text-ink-400 mt-1">{description}</p>
          </div>
          <button onClick={onCancel} className="w-8 h-8 rounded-lg hover:bg-surface-alt flex items-center justify-center text-ink-500 shrink-0">
            <IconX className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="font-arabic text-sm text-ink-500 mb-1.5 block">
              كلمة مرور المدير
            </label>
            <input
              type="password"
              value={pin}
              onChange={(e) => setDigits(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleVerify();
              }}
              className="w-full h-12 text-center font-mono text-lg bg-white border-2 border-ink-200 rounded-sm outline-none focus:border-accent transition-all"
              autoFocus
              dir="ltr"
              maxLength={6}
            />
          </div>

          {error && (
            <p className="text-danger text-sm text-center font-arabic">{error}</p>
          )}

          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button
                key={n}
                onClick={() => setDigits(pin + String(n))}
                className="h-12 rounded-xl bg-white border border-ink-200 font-mono text-lg font-bold text-ink-900 hover:bg-ink-100 active:bg-ink-100 transition-colors"
              >
                {n}
              </button>
            ))}
            <button
              onClick={() => setDigits(pin.slice(0, -1))}
              className="h-12 rounded-xl bg-white border border-ink-200 text-ink-500 hover:bg-ink-100 flex items-center justify-center transition-colors"
            >
              <IconBackspace className="w-5 h-5" stroke={1.75} />
            </button>
            <button
              onClick={() => setDigits(pin + "0")}
              className="h-12 rounded-xl bg-white border border-ink-200 font-mono text-lg font-bold text-ink-900 hover:bg-ink-100 transition-colors"
            >
              0
            </button>
            <button
              onClick={() => setDigits("")}
              className="h-12 rounded-xl bg-white border border-ink-200 text-ink-500 hover:bg-ink-100 flex items-center justify-center transition-colors"
            >
              <IconX className="w-4 h-4" stroke={1.75} />
            </button>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-ink-200 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 h-12 rounded-xl bg-surface-alt text-ink-900 font-arabic font-bold hover:bg-ink-200 transition-colors"
          >
            إلغاء
          </button>
          <button
            onClick={handleVerify}
            disabled={loading || pin.length < 4}
            className="flex-1 h-12 rounded-xl bg-saffron-600 text-white font-arabic font-bold hover:bg-accent-text disabled:opacity-50 transition-all"
          >
            {loading ? "جاري..." : "تأكيد"}
          </button>
        </div>
      </div>
    </div>
  );
}
