import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { formatArabicDateTime } from "../../lib/dateLocal";
import { formatQty } from "../../lib/shop";
import { Hint } from "../payroll/ui";

interface LogRow {
  id: string;
  menu_item_id: string;
  name: string;
  change: number;
  balance_after: number;
  reason: string;
  note: string | null;
  user_name: string | null;
  created_at: string;
}

const REASON: Record<string, string> = { SALE: "بيع", RECEIVE: "استلام", ADJUST: "تعديل", COUNT: "جرد", OPENING: "رصيد افتتاحي", RETURN: "مرتجع إلى المخزون" };

/** Every movement of every product, newest first, with the balance after it and who did it. */
export default function LogTab({ refreshKey }: { refreshKey: number }) {
  const token = useAuthStore((s) => s.token);
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setError(null);
      setRows(await invoke<LogRow[]>("list_product_stock_log_v3", { sessionToken: token, itemId: null, limit: 300 }));
    } catch (err) { setError(realErrorText(err)); }
  }, [token]);
  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <div className="space-y-4" data-testid="log-tab">
      <Hint summary="آخر 300 حركة. لا يتغير مخزون بلا أثر هنا: بيع، استلام، جرد، تعديل بسبب، أو مرتجع أُعيد للرف." />
      {error && <p className="text-danger font-arabic text-sm">{error}</p>}
      <div className="zc-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic"><th className="text-right p-3 font-medium">الوقت</th><th className="text-right p-3 font-medium">المنتج</th><th className="text-center p-3 font-medium">النوع</th><th className="text-center p-3 font-medium">التغيير</th><th className="text-center p-3 font-medium">الرصيد بعده</th><th className="text-right p-3 font-medium">بواسطة / ملاحظة</th></tr></thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id} className="border-b border-ink-100">
                <td className="p-3 font-arabic text-ink-500 text-xs">{formatArabicDateTime(new Date(r.created_at))}</td>
                <td className="p-3 font-arabic font-medium">{r.name}</td>
                <td className="p-3 text-center font-arabic">{REASON[r.reason] ?? r.reason}</td>
                <td className={`p-3 text-center font-mono font-bold ${r.change < 0 ? "text-danger" : "text-ok"}`} dir="ltr">{r.change > 0 ? "+" : ""}{formatQty(r.change)}</td>
                <td className="p-3 text-center font-mono">{formatQty(r.balance_after)}</td>
                <td className="p-3 font-arabic text-ink-500 text-xs">{[r.user_name, r.note].filter(Boolean).join(" · ")}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-ink-500 font-arabic">لا توجد حركات بعد.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
