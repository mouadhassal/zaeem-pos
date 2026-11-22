import { useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { realErrorText } from "../../lib/errors";
import { formatMoney } from "../../lib/money";
import { getOrderHistoryDetail, historyNumber, type HistoryDetail, type HistoryRow } from "../../lib/orderHistory";
import { OrderDetail, TYPE_LABEL, statusPill, timeOf } from "../orders/page";
import { formatArabicDate } from "../../lib/dateLocal";
import type { ReportRange } from "./ReportParts";

/** What a tapped report row opens: the orders behind a breakdown row, or one order. */
export type DrillTarget = { title: string; kind: string; key: string } | { title: string; orderId: string };

const noop = () => {};

/**
 * The orders behind a report row, in the order history's own look: a list on one side and, for the one
 * you tap, the full order (items, discount, payments, refunds) on the other. Read only.
 */
export default function DrillDown({ target, range, onClose }: { target: DrillTarget; range: ReportRange; onClose: () => void }) {
  const token = useAuthStore((s) => s.token);
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>("orderId" in target ? target.orderId : null);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    if ("orderId" in target) return;
    let cancelled = false;
    invoke<HistoryRow[]>("list_breakdown_orders_v3", { sessionToken: token, startIso: range.startIso, endIso: range.endIso, kind: target.kind, key: target.key, tzOffsetMinutes: range.tz })
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => {
        if (!cancelled) setError(realErrorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [token, target, range.startIso, range.endIso, range.tz]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    getOrderHistoryDetail(selected)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setDetailError(realErrorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const total = (rows ?? []).reduce((s, r) => s + r.total_cents, 0);
  const single = "orderId" in target;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" data-testid="drill-down" dir="rtl">
      <div className="w-full max-w-5xl max-h-[90vh] rounded-md bg-white border border-ink-200 shadow-2xl flex flex-col font-arabic">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-ink-200">
          <div>
            <h2 className="font-bold text-ink-900">{target.title}</h2>
            {!single && rows && (
              <p className="text-xs text-ink-400 mt-0.5">
                {rows.length} طلب · الإجمالي <span className="font-mono tabular" dir="ltr">{formatMoney(total)}</span>
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="text-ink-500 text-sm h-8 w-8 rounded-sm hover:bg-surface-alt" data-testid="drill-close">✕</button>
        </div>
        <div className={`flex-1 min-h-0 grid ${single ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_minmax(0,380px)]"}`}>
          {!single && (
            <div className="overflow-y-auto p-3 space-y-1.5 border-l border-ink-200">
              {!rows && !error && <p className="text-sm text-ink-400 p-3">جاري التحميل...</p>}
              {error && <p className="text-sm text-danger p-3">{error}</p>}
              {rows && rows.length === 0 && <p className="text-sm text-ink-400 p-3">لا توجد طلبات.</p>}
              {rows?.map((r) => {
                const pill = statusPill(r);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelected(r.id)}
                    data-testid="drill-row"
                    className={`w-full text-right rounded-md border px-3 py-2 grid grid-cols-[80px_minmax(0,1fr)_auto_auto] items-center gap-3 ${selected === r.id ? "border-accent bg-accent-soft" : "border-ink-200 bg-white hover:bg-surface-alt"}`}
                  >
                    <span className="font-mono font-bold text-ink-900" dir="ltr">{historyNumber(r)}</span>
                    <span className="min-w-0 truncate text-sm text-ink-700">
                      {formatArabicDate(new Date(r.created_at))} {timeOf(r.closed_at ?? r.created_at)} · {TYPE_LABEL[r.order_type] ?? r.order_type}
                      {r.table_name && r.order_type === "DINE_IN" ? ` · ${r.table_name}` : ""}
                      {r.cashier_name ? <span className="text-ink-400"> · {r.cashier_name}</span> : null}
                    </span>
                    <span className="font-mono font-bold text-sm tabular" dir="ltr">{formatMoney(r.total_cents)}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold whitespace-nowrap ${pill.cls}`}>{pill.label}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="overflow-y-auto p-4" data-testid="drill-detail">
            {!selected && <p className="text-sm text-ink-400 text-center p-4">اختر طلباً لعرض تفاصيله</p>}
            {detailError && <p className="text-sm text-danger p-3">{detailError}</p>}
            {selected && !detail && !detailError && <p className="text-sm text-ink-400 p-3">جاري التحميل...</p>}
            {detail && detail.id === selected && <OrderDetail d={detail} printing={false} canRefund={false} onReprint={noop} onRefund={noop} readOnly />}
          </div>
        </div>
      </div>
    </div>
  );
}
