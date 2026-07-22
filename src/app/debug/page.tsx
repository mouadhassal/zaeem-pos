import { useEffect, useState } from "react";
import { getMemoryUsage, getAverageFps } from "../../lib/performance";
import { useCartStore } from "../../stores/cartStore";
import { useAuthStore } from "../../stores/authStore";
import { invoke } from "@tauri-apps/api/core";

// The database section (integrity/WAL/order count/sync queue) used to read
// via the old Kysely helper -- a second SQLite connection through the SQL plugin,
// entirely separate from Rust's own. That dependency is gone (Batch 3b
// closeout: the frontend no longer touches the database at all). Not
// replaced with equivalent Rust commands -- this is a dev-only diagnostic
// page (`import.meta.env.DEV` gated below, on top of `diagnose_db` itself
// refusing in release builds), not worth new backend surface for.
function DebugPageContent() {
  const [memory, setMemory] = useState({ heapUsedMB: 0, heapTotalMB: 0 });
  const [fps, setFps] = useState(0);
  const [diagnose, setDiagnose] = useState("");
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

      setMemory(getMemoryUsage());
      setFps(getAverageFps());
    })();
  }, []);

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <h1 className="text-xl font-bold text-ink-900 font-arabic">التشخيص</h1>

      {diagnose && (
        <div className="bg-white rounded-2xl p-4 shadow-sh-1 space-y-1">
          <h2 className="font-bold text-ink-900 font-arabic text-sm">تشخيص قاعدة البيانات</h2>
          <pre className="text-xs font-mono whitespace-pre-wrap text-ink-500">{diagnose}</pre>
        </div>
      )}

      <div className="bg-white rounded-2xl p-4 shadow-sh-1 space-y-2">
        <h2 className="font-bold text-ink-900 font-arabic">الأداء</h2>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-ink-400 font-arabic">الذاكرة</span>
            <span className="font-mono">{memory.heapUsedMB} / {memory.heapTotalMB} MB</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-400 font-arabic">FPS</span>
            <span className={`font-mono ${fps < 30 ? "text-red-500" : fps < 50 ? "text-amber-500" : "text-saffron-600"}`}>
              {fps}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-400 font-arabic">السلة</span>
            <span className="font-mono">{cartItems} أصناف</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-400 font-arabic">المستخدم</span>
            <span className="font-mono font-arabic">{user?.name ?? "---"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DebugPage() {
  if (!import.meta.env.DEV) return null;
  return <DebugPageContent />;
}
