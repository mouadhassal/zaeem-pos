import { useEffect, useState } from "react";
import { getDb } from "../../db";
import { checkIntegrity, getWalMode } from "../../db/corruption";
import { getMemoryUsage, getAverageFps } from "../../lib/performance";
import { useCartStore } from "../../stores/cartStore";
import { useAuthStore } from "../../stores/authStore";
import { invoke } from "@tauri-apps/api/core";

export default function DebugPage() {
  const [integrity, setIntegrity] = useState<{ ok: boolean; errors: string[] } | null>(null);
  const [walMode, setWal] = useState(false);
  const [queueSize, setQueueSize] = useState(0);
  const [memory, setMemory] = useState({ heapUsedMB: 0, heapTotalMB: 0 });
  const [fps, setFps] = useState(0);
  const [orderCount, setOrderCount] = useState(0);
  const [diagnose, setDiagnose] = useState("");
  const [dbError, setDbError] = useState("");
  const user = useAuthStore((s) => s.user);
  const cartItems = useCartStore((s) => s.items.length);

  useEffect(() => {
    (async () => {
      try {
        const diag = await invoke<string>("diagnose_db");
        setDiagnose(diag);
      } catch (e) {
        setDiagnose("diagnose_db failed: " + String(e));
      }

      const result = await checkIntegrity();
      setIntegrity(result);

      const wal = await getWalMode();
      setWal(wal);

      try {
        const db = await getDb();
        const count = await db
          .selectFrom("orders")
          .select(db.fn.count<number>("id").as("count"))
          .executeTakeFirst();
        setOrderCount(count?.count ?? 0);

        const queue = await db
          .selectFrom("sync_queue")
          .select(db.fn.count<number>("id").as("count"))
          .where("sync_status", "=", "pending")
          .executeTakeFirst();
        setQueueSize(queue?.count ?? 0);
      } catch (e) {
        setDbError(String(e));
      }

      setMemory(getMemoryUsage());
      setFps(getAverageFps());
    })();
  }, []);

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <h1 className="text-xl font-bold text-slate-900 font-arabic">التشخيص</h1>

      {diagnose && (
        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-1">
          <h2 className="font-bold text-slate-900 font-arabic text-sm">تشخيص قاعدة البيانات</h2>
          <pre className="text-xs font-mono whitespace-pre-wrap text-slate-500">{diagnose}</pre>
        </div>
      )}

      {dbError && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
          <h2 className="font-bold text-red-700 text-sm font-arabic">خطأ DB</h2>
          <pre className="text-xs font-mono whitespace-pre-wrap text-red-600 mt-1">{dbError}</pre>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-2">
          <h2 className="font-bold text-slate-900 font-arabic">قاعدة البيانات</h2>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400 font-arabic">السلامة</span>
              <span className={`font-mono ${integrity?.ok ? "text-emerald-600" : "text-red-500"}`}>
                {integrity?.ok ? "سليمة ✓" : `تلف: ${integrity?.errors.join(", ")}`}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400 font-arabic">WAL</span>
              <span className="font-mono">{walMode ? "مفعل" : "غير مفعل"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400 font-arabic">الطلبات</span>
              <span className="font-mono">{orderCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400 font-arabic">انتظار المزامنة</span>
              <span className="font-mono">{queueSize}</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-2">
          <h2 className="font-bold text-slate-900 font-arabic">الأداء</h2>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400 font-arabic">الذاكرة</span>
              <span className="font-mono">{memory.heapUsedMB} / {memory.heapTotalMB} MB</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400 font-arabic">FPS</span>
              <span className={`font-mono ${fps < 30 ? "text-red-500" : fps < 50 ? "text-amber-500" : "text-emerald-600"}`}>
                {fps}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400 font-arabic">السلة</span>
              <span className="font-mono">{cartItems} أصناف</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400 font-arabic">المستخدم</span>
              <span className="font-mono font-arabic">{user?.name ?? "---"}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
