import { useState } from "react";
import { getDb } from "../../db";
import { verifyPassword } from "../../lib/auth";

interface Props {
  title: string;
  description: string;
  onSuccess: () => void;
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

  const handleVerify = async () => {
    setLoading(true);
    setError(null);

    try {
      const db = await getDb();
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
        setError("كلمة المرور غير صحيحة");
        setLoading(false);
        return;
      }

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
      <div className="bg-white rounded-2xl shadow-elevated w-[380px] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h3 className="font-arabic font-bold text-lg text-slate-900">{title}</h3>
          <p className="font-arabic text-sm text-slate-400 mt-1">{description}</p>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="font-arabic text-sm text-slate-500 mb-1.5 block">
              كلمة مرور المدير
            </label>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleVerify();
              }}
              className="w-full h-12 text-center font-mono text-lg bg-white border-2 border-slate-200 rounded-xl outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 transition-all"
              autoFocus
              dir="ltr"
            />
          </div>

          {error && (
            <p className="text-red-500 text-sm text-center font-arabic">{error}</p>
          )}

          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button
                key={n}
                onClick={() => setPin((p) => p + n)}
                className="h-12 rounded-xl bg-white border border-slate-200 font-mono text-lg font-bold text-slate-900 hover:bg-white active:bg-white"
              >
                {n}
              </button>
            ))}
            <button
              onClick={() => setPin((p) => p.slice(0, -1))}
              className="h-12 rounded-xl bg-white border border-slate-200 text-slate-500 hover:bg-white flex items-center justify-center"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z" />
                <path d="M18 9l-6 6M12 9l6 6" />
              </svg>
            </button>
            <button
              onClick={() => setPin((p) => p + "0")}
              className="h-12 rounded-xl bg-white border border-slate-200 font-mono text-lg font-bold text-slate-900 hover:bg-white"
            >
              0
            </button>
            <button
              onClick={() => setPin("")}
              className="h-12 rounded-xl bg-white border border-slate-200 text-slate-500 hover:bg-white flex items-center justify-center"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 h-12 rounded-xl bg-white text-slate-900 font-arabic font-bold hover:bg-slate-200 transition-colors"
          >
            إلغاء
          </button>
          <button
            onClick={handleVerify}
            disabled={loading || pin.length < 4}
            className="flex-1 h-12 rounded-xl bg-emerald-600 text-white font-arabic font-bold hover:bg-emerald-700 shadow-lg shadow-emerald-600\/20 disabled:opacity-50 transition-all"
          >
            {loading ? "جاري..." : "تأكيد"}
          </button>
        </div>
      </div>
    </div>
  );
}
