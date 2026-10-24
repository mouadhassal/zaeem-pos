import { useEffect, useState } from "react";
import { formatMoney } from "../../lib/money";
import { formatArabicDateTime } from "../../lib/dateLocal";
import { useOrderLabels } from "../../lib/orderLabels";
import { realErrorText } from "../../lib/errors";
import { listPickupNoShows, type PickupNoShow } from "../../lib/orderService";

/**
 * Phone orders cancelled because the customer never came, in the chosen
 * period: who cancelled them and why. The owner's check that "never came"
 * is not hiding a sale whose cash was kept.
 */
export default function NoShowReport({ startIso, endIso }: { startIso: string; endIso: string | null }) {
  const [rows, setRows] = useState<PickupNoShow[] | null>(null);
  const labelOf = useOrderLabels(rows?.map((r) => r.order_id) ?? []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const from = new Date(startIso).getTime();
    const to = endIso ? new Date(endIso).getTime() : Date.now();
    listPickupNoShows(from, to)
      .then((r) => { if (!cancelled) { setRows(r); setError(null); } })
      .catch((e) => { if (!cancelled) setError(realErrorText(e)); });
    return () => { cancelled = true; };
  }, [startIso, endIso]);

  const total = (rows ?? []).reduce((s, r) => s + r.total_cents, 0);

  return (
    <div className="zc-card p-4 space-y-3" data-testid="no-show-report">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-ink-900 font-arabic">طلبات لم تُستلم</h2>
          <p className="text-xs text-ink-400 font-arabic mt-0.5">طلبات هاتفية أُلغيت لأن الزبون لم يحضر: السبب ومن ألغاها</p>
        </div>
        <div className="text-end">
          <div className="text-xs text-ink-500 font-arabic">قيمة الطلبات</div>
          <div className="font-bold tabular font-arabic">{formatMoney(total)}</div>
        </div>
      </div>
      {error && <p className="text-danger text-sm font-arabic">{error}</p>}
      {rows && rows.length === 0 && <p className="text-ink-400 text-sm font-arabic">لا توجد طلبات غير مستلمة في هذه الفترة</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-arabic">
            <thead className="text-ink-500"><tr>{["الطلب", "الزبون", "موعد الاستلام", "أُلغي", "القيمة", "السبب", "ألغاه"].map((h) => <th key={h} className="p-2 text-start whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.order_id} className="border-t border-ink-100" data-testid="no-show-row">
                  <td className="p-2"><span dir="ltr">{labelOf(r.order_id)}</span></td>
                  <td className="p-2">{r.customer_name}{r.customer_phone ? <span className="block font-mono text-xs text-ink-400" dir="ltr">{r.customer_phone}</span> : null}</td>
                  <td className="p-2 whitespace-nowrap">{formatArabicDateTime(new Date(r.pickup_at_ms))}</td>
                  <td className="p-2 whitespace-nowrap">{formatArabicDateTime(new Date(r.closed_at_ms))}</td>
                  <td className="p-2 tabular">{formatMoney(r.total_cents)}</td>
                  <td className="p-2">{r.reason}</td>
                  <td className="p-2">{r.by_name ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
