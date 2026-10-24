import { useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { formatMoney } from "../../lib/money";
import { formatArabicDateTime } from "../../lib/dateLocal";
import { useOrderLabels } from "../../lib/orderLabels";
import { realErrorText } from "../../lib/errors";

interface GiftRow {
  order_id: string;
  created_at: string;
  item_name: string;
  quantity: number;
  value_cents: number;
  reason: string | null;
  given_by: string | null;
  order_type: string;
}

/** Everything given away ("on the house") in the chosen period: what, its value, why, and who gave it. */
export default function GiftsReport({ startIso, endIso }: { startIso: string; endIso: string | null }) {
  const token = useAuthStore((s) => s.token);
  const [rows, setRows] = useState<GiftRow[] | null>(null);
  const labelOf = useOrderLabels(rows?.map((r) => r.order_id) ?? []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<GiftRow[]>("gifts_report_v3", { sessionToken: token, startIso, endIso })
      .then((r) => { if (!cancelled) { setRows(r); setError(null); } })
      .catch((e) => { if (!cancelled) setError(realErrorText(e)); });
    return () => { cancelled = true; };
  }, [token, startIso, endIso]);

  const total = (rows ?? []).reduce((s, r) => s + r.value_cents, 0);
  const byPerson = new Map<string, number>();
  for (const r of rows ?? []) byPerson.set(r.given_by ?? "—", (byPerson.get(r.given_by ?? "—") ?? 0) + r.value_cents);

  return (
    <div className="zc-card p-4 space-y-3" data-testid="gifts-report">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-ink-900 font-arabic">الضيافة (مجاناً)</h2>
          <p className="text-xs text-ink-400 font-arabic mt-0.5">كل ما قُدّم مجاناً: القيمة والسبب ومن قدّمه</p>
        </div>
        <div className="text-end">
          <div className="text-xs text-ink-500 font-arabic">إجمالي القيمة</div>
          <div className="font-bold tabular font-arabic" data-testid="gifts-total">{formatMoney(total)}</div>
        </div>
      </div>
      {error && <p className="text-danger text-sm font-arabic">{error}</p>}
      {rows && rows.length === 0 && <p className="text-ink-400 text-sm font-arabic" data-testid="gifts-empty">لا توجد ضيافة في هذه الفترة</p>}
      {rows && rows.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2 text-xs font-arabic">
            {[...byPerson.entries()].map(([who, v]) => (
              <span key={who} className="px-2.5 py-1 rounded-full bg-surface-alt text-ink-700">{who}: {formatMoney(v)}</span>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-arabic">
              <thead className="text-ink-500"><tr>{["الطلب", "الوقت", "الصنف", "الكمية", "القيمة", "السبب", "قدّمها"].map((h) => <th key={h} className="p-2 text-start whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.order_id}-${i}`} className="border-t border-ink-100" data-testid="gift-row">
                    <td className="p-2"><span dir="ltr">{labelOf(r.order_id)}</span></td>
                    <td className="p-2 whitespace-nowrap">{formatArabicDateTime(new Date(r.created_at))}</td>
                    <td className="p-2">{r.item_name}</td>
                    <td className="p-2">{r.quantity}</td>
                    <td className="p-2 tabular">{formatMoney(r.value_cents)}</td>
                    <td className="p-2">{r.reason}</td>
                    <td className="p-2">{r.given_by ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
