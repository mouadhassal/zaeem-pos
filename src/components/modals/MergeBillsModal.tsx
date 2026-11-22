import { useEffect, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { listOpenOrders, type OpenOrderSummary } from "../../lib/orderService";
import { formatMoney } from "../../lib/money";
import { realErrorText } from "../../lib/errors";

interface Props {
  /** The bill on screen: the others are pulled into it. */
  currentOrderId: string;
  onMerge: (sourceOrderIds: string[]) => void | Promise<void>;
  onCancel: () => void;
}

const TYPE_LABELS: Record<string, string> = { DINE_IN: "صالة", TAKEAWAY: "سفري", DELIVERY: "توصيل", ONLINE: "أونلاين" };

/** What a bill is called in the list: its number, and the table or the customer. */
export function billTitle(o: OpenOrderSummary): string {
  const where = o.table_name && o.table_name !== "المنضدة" ? `طاولة ${o.table_name}` : o.customer_name || TYPE_LABELS[o.order_type] || o.order_type;
  return `${o.label ? `#${o.label} · ` : ""}${where}`;
}

/** "دمج فواتير": pick the other open bills (held, takeaway, on a table) to pull into the bill on screen. */
export default function MergeBillsModal({ currentOrderId, onMerge, onCancel }: Props) {
  const [orders, setOrders] = useState<OpenOrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listOpenOrders()
      .then((rows) => setOrders(rows.filter((o) => o.id !== currentOrderId)))
      .catch((e) => setError(realErrorText(e)));
  }, [currentOrderId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const pickedTotal = (orders ?? []).filter((o) => picked.includes(o.id)).reduce((s, o) => s + o.total_cents, 0);

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50" data-testid="merge-bills-modal">
      <div className="bg-white rounded-md border border-line shadow-sh-3 w-[520px] max-w-[95vw]" dir="rtl">
        <div className="px-6 py-4 border-b border-ink-200 flex items-center justify-between">
          <div>
            <h2 className="font-arabic font-bold text-lg text-ink-900">دمج فواتير</h2>
            <p className="font-arabic text-sm text-ink-400 mt-1">اختر الفواتير المفتوحة التي تريد ضمّها إلى هذه الفاتورة.</p>
          </div>
          <button onClick={onCancel} className="w-8 h-8 rounded-lg hover:bg-surface-alt flex items-center justify-center text-ink-500 shrink-0" aria-label="إغلاق">
            <IconX className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 max-h-[55vh] overflow-y-auto space-y-2">
          {error && <p className="font-arabic text-sm text-danger text-center py-4">{error}</p>}
          {!error && orders === null && <p className="font-arabic text-ink-500 text-center py-8">جاري التحميل...</p>}
          {orders !== null && orders.length === 0 && <p className="font-arabic text-ink-500 text-center py-8">لا توجد فواتير مفتوحة أخرى</p>}
          {(orders ?? []).map((o) => {
            const on = picked.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => toggle(o.id)}
                data-testid="merge-bill-row"
                className={`w-full min-h-14 rounded-xl px-4 py-2 flex items-center gap-3 text-start border-2 transition-colors ${on ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-surface-alt"}`}
              >
                <span className={`w-5 h-5 rounded-md border-2 shrink-0 flex items-center justify-center text-xs ${on ? "bg-accent border-accent text-white" : "border-ink-300"}`}>{on ? "✓" : ""}</span>
                <span className="flex-1 font-arabic">
                  <span className="block font-bold text-ink-900 text-sm">{billTitle(o)}</span>
                  <span className="block text-xs text-ink-500">{TYPE_LABELS[o.order_type] ?? o.order_type} · {o.item_count} صنف{o.status === "DRAFT" ? " · معلّقة" : ""}</span>
                </span>
                <span className="font-bold text-sm text-ink-900 shrink-0">{formatMoney(o.total_cents)}</span>
              </button>
            );
          })}
        </div>

        <div className="px-6 py-4 border-t border-ink-200 flex gap-3">
          <button onClick={onCancel} className="flex-1 h-12 rounded-xl bg-surface-alt text-ink-900 font-arabic font-bold hover:bg-ink-200">إلغاء</button>
          <button
            disabled={picked.length === 0 || busy}
            data-testid="merge-bills-confirm"
            onClick={async () => {
              setBusy(true);
              try { await onMerge(picked); } finally { setBusy(false); }
            }}
            className="flex-1 h-12 rounded-xl bg-saffron-600 text-white font-arabic font-bold hover:bg-accent-text disabled:opacity-50"
          >
            {picked.length === 0 ? "دمج" : `دمج ${picked.length} فاتورة (+${formatMoney(pickedTotal)})`}
          </button>
        </div>
      </div>
    </div>
  );
}
