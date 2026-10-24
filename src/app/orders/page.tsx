import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPrinter, IconReceiptRefund, IconRefresh, IconSearch } from "@tabler/icons-react";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney } from "../../lib/money";
import { realErrorText } from "../../lib/errors";
import { formatArabicDate, formatArabicTime, parseLocalDateStr, toLocalDateStr } from "../../lib/dateLocal";
import { orderStatusLabel } from "../../lib/orderStatus";
import { getReceiptConfig } from "../../lib/orderService";
import { printReceipt } from "../../lib/printer";
import type { ReceiptData } from "../../lib/ticketLayout";
import {
  OPEN_STATUSES,
  getOrderHistoryDetail,
  historyNumber,
  listOrderHistory,
  receiptFromHistory,
  recordReceiptReprint,
  type HistoryDay,
  type HistoryDetail,
  type HistoryRow,
} from "../../lib/orderHistory";
import RefundModal from "../../components/modals/RefundModal";
import OnScreenReceiptModal from "../../components/modals/OnScreenReceiptModal";

const TYPE_LABEL: Record<string, string> = { TAKEAWAY: "سفري", DINE_IN: "صالة", DELIVERY: "توصيل", ONLINE: "أونلاين" };
const METHOD_LABEL: Record<string, string> = { CASH: "نقداً", CARD: "بطاقة", WALLET: "محفظة", CREDIT: "دين" };
const MANAGER_ROLES = ["MANAGER", "OWNER", "PLATFORM", "ADMIN"];

type StatusFilter = "ALL" | "PAID" | "OPEN" | "REFUNDED" | "CANCELLED";
const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "ALL", label: "الكل" },
  { id: "PAID", label: "مدفوع" },
  { id: "OPEN", label: "مفتوح" },
  { id: "REFUNDED", label: "مسترد" },
  { id: "CANCELLED", label: "ملغى" },
];
type TypeFilter = "ALL" | "TAKEAWAY" | "DINE_IN" | "DELIVERY";
const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: "ALL", label: "كل الأنواع" },
  { id: "TAKEAWAY", label: "سفري A" },
  { id: "DINE_IN", label: "صالة B" },
  { id: "DELIVERY", label: "توصيل C" },
];

function statusPill(row: HistoryRow): { label: string; cls: string } {
  if (row.refunded_cents > 0 && row.refunded_cents >= row.total_cents) return { label: "مسترد", cls: "bg-danger-soft text-danger" };
  if (row.refunded_cents > 0) return { label: "مسترد جزئياً", cls: "bg-warn-soft text-warn" };
  if (row.status === "PAID") return { label: "مدفوع", cls: "bg-ok-soft text-ok" };
  if (row.status === "CANCELLED" || row.status === "VOIDED") return { label: "ملغى", cls: "bg-surface-alt text-text-muted" };
  if (OPEN_STATUSES.includes(row.status)) return { label: "مفتوح", cls: "bg-accent-soft text-accent-text" };
  return { label: orderStatusLabel(row.status), cls: "bg-surface-alt text-text-3" };
}

function matchesStatus(row: HistoryRow, f: StatusFilter): boolean {
  switch (f) {
    case "ALL": return true;
    case "PAID": return row.status === "PAID" && row.refunded_cents === 0;
    case "OPEN": return OPEN_STATUSES.includes(row.status);
    case "REFUNDED": return row.refunded_cents > 0;
    case "CANCELLED": return row.status === "CANCELLED" || row.status === "VOIDED";
  }
}

/** "7", "0007", "a7", "A-0007" all find A-0007; also the customer's name or phone. */
function matchesQuery(row: HistoryRow, typed: string): boolean {
  const query = typed.trim().toLowerCase();
  if (!query) return true;
  const num = historyNumber(row).toLowerCase().replace(/[^a-z0-9]/g, ""); // "a0007"
  const q = query.replace(/[^a-z0-9]/g, "");
  if (q && num.includes(q)) return true;
  const short = q.match(/^([a-d]?)(\d+)$/); // "a7"
  if (short && row.number && (!short[1] || num.startsWith(short[1])) && Number(short[2]) === Number(num.replace(/\D/g, ""))) return true;
  return (row.customer_name ?? "").toLowerCase().includes(query) || (row.customer_phone ?? "").includes(query);
}

const dayLabel = (date: string) => formatArabicDate(parseLocalDateStr(date), { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const timeOf = (iso: string | null | undefined) => (iso ? formatArabicTime(new Date(iso)) : "—");

/**
 * Order history: every order of one business day (it changes at 05:00) with
 * its daily number, and for one order everything that happened to it -- a
 * receipt can be printed again (logged) and a paid order refunded. A cashier
 * sees only the orders they took today.
 */
export default function OrdersPage() {
  const user = useAuthStore((s) => s.user);
  const isManager = MANAGER_ROLES.includes(String(user?.role ?? "").toUpperCase());
  const toast = useToast();
  const [date, setDate] = useState<string | undefined>(undefined);
  const [day, setDay] = useState<HistoryDay | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [type, setType] = useState<TypeFilter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [refunding, setRefunding] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [onScreen, setOnScreen] = useState<ReceiptData | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setDay(await listOrderHistory(date));
    } catch (e) {
      setLoadError(`تعذر تحميل الطلبات: ${realErrorText(e)}`);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailError(null);
    try {
      setDetail(await getOrderHistoryDetail(id));
    } catch (e) {
      setDetail(null);
      setDetailError(realErrorText(e));
    }
  }, []);

  const rows = useMemo(
    () => (day?.rows ?? []).filter((r) => matchesStatus(r, status) && (type === "ALL" || r.order_type === type) && matchesQuery(r, query)),
    [day, status, type, query],
  );
  const summary = useMemo(() => {
    const all = day?.rows ?? [];
    const paid = all.filter((r) => r.status === "PAID");
    return {
      count: all.filter((r) => r.status !== "CANCELLED" && r.status !== "VOIDED").length,
      paid: paid.reduce((s, r) => s + r.total_cents, 0),
      refunded: all.reduce((s, r) => s + r.refunded_cents, 0),
    };
  }, [day]);

  const shiftDay = (delta: number) => {
    const base = parseLocalDateStr(day?.business_date ?? toLocalDateStr(new Date()));
    base.setDate(base.getDate() + delta);
    setDate(toLocalDateStr(base));
    setSelectedId(null);
    setDetail(null);
  };

  const reprint = async () => {
    if (!detail) return;
    setPrinting(true);
    try {
      const receipt = receiptFromHistory(detail, await getReceiptConfig());
      await recordReceiptReprint(detail.id);
      try {
        await printReceipt(receipt);
        toast.success("طُبعت نسخة من الإيصال ✓");
      } catch {
        setOnScreen(receipt);
      }
    } catch (e) {
      toast.error(`تعذرت الطباعة: ${realErrorText(e)}`);
    } finally {
      setPrinting(false);
    }
  };

  const isToday = day ? day.business_date === day.today : true;
  const canRefund = detail && detail.status === "PAID" && detail.refunded_cents < detail.total_cents;

  return (
    <div className="h-full flex flex-col overflow-hidden" dir="rtl" data-testid="history-page">
      <div className="px-6 pt-6 pb-4 space-y-4 border-b border-line">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-text">سجل الطلبات</h1>
            <p className="text-sm text-text-3 font-arabic mt-0.5" data-testid="history-day">
              {day ? dayLabel(day.business_date) : "…"}
              {day?.own_only && <span className="text-text-muted"> · طلباتك اليوم فقط</span>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isManager && (
              <>
                <button onClick={() => shiftDay(-1)} className="h-9 px-3 rounded-sm border border-line bg-white text-sm font-arabic text-text-2 hover:bg-surface-alt">اليوم السابق</button>
                <button onClick={() => shiftDay(1)} disabled={isToday} className="h-9 px-3 rounded-sm border border-line bg-white text-sm font-arabic text-text-2 hover:bg-surface-alt disabled:opacity-40">اليوم التالي</button>
                <input type="date" value={day?.business_date ?? ""} max={day?.today} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setSelectedId(null); setDetail(null); } }}
                  aria-label="اختر اليوم" data-testid="history-date"
                  className="h-9 px-2 rounded-sm border border-line bg-white text-sm font-mono" dir="ltr" />
                {!isToday && (
                  <button onClick={() => { setDate(undefined); setSelectedId(null); setDetail(null); }} className="h-9 px-3 rounded-sm bg-accent text-white text-sm font-bold font-arabic">اليوم</button>
                )}
              </>
            )}
            <button onClick={() => void load()} aria-label="تحديث" className="h-9 w-9 rounded-sm border border-line bg-white flex items-center justify-center text-text-3 hover:bg-surface-alt">
              <IconRefresh className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm font-arabic">
          <span className="text-text-3">الطلبات <b className="text-text tabular" data-testid="history-count">{summary.count}</b></span>
          <span className="text-text-3">المدفوع <b className="text-text font-mono tabular" dir="ltr">{formatMoney(summary.paid)}</b></span>
          {summary.refunded > 0 && (
            <span className="text-text-3">المسترد <b className="text-danger font-mono tabular" dir="ltr">-{formatMoney(summary.refunded)}</b></span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <IconSearch className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="رقم الطلب أو اسم الزبون أو الهاتف" data-testid="history-search"
              className="w-full h-9 pr-9 pl-3 rounded-sm border border-line bg-white text-sm font-arabic outline-none focus:border-accent" />
          </div>
          {STATUS_FILTERS.map((f) => (
            <button key={f.id} onClick={() => setStatus(f.id)} data-testid={`history-status-${f.id}`}
              className={`h-8 px-3 rounded-full text-xs font-bold font-arabic ${status === f.id ? "bg-text text-white" : "bg-surface-alt text-text-3 hover:bg-line"}`}>{f.label}</button>
          ))}
          <span className="w-px h-6 bg-line mx-1" />
          {TYPE_FILTERS.map((f) => (
            <button key={f.id} onClick={() => setType(f.id)}
              className={`h-8 px-3 rounded-full text-xs font-bold font-arabic ${type === f.id ? "bg-text text-white" : "bg-surface-alt text-text-3 hover:bg-line"}`}>{f.label}</button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        <div className="overflow-y-auto p-4 space-y-1.5 border-l border-line">
          {loading && <p className="text-sm text-text-muted font-arabic p-4">جاري التحميل...</p>}
          {loadError && <p className="text-sm text-danger font-arabic p-4">{loadError}</p>}
          {!loading && !loadError && rows.length === 0 && (
            <p className="text-sm text-text-muted font-arabic p-4">{(day?.rows.length ?? 0) === 0 ? "لا توجد طلبات في هذا اليوم." : "لا توجد طلبات تطابق البحث."}</p>
          )}
          {rows.map((r) => {
            const pill = statusPill(r);
            const where = r.order_type === "DINE_IN" && r.table_name ? r.table_name : r.customer_name;
            return (
              <button key={r.id} onClick={() => void openDetail(r.id)} data-testid="history-row"
                className={`w-full text-right rounded-md border px-3 py-2.5 grid grid-cols-[88px_72px_minmax(0,1fr)_auto_auto] items-center gap-3 transition-colors ${selectedId === r.id ? "border-accent bg-accent-soft" : "border-line bg-white hover:bg-surface-alt"}`}>
                <span className="font-mono font-bold text-text text-[15px]" dir="ltr" data-testid="history-number">{historyNumber(r)}</span>
                <span className="font-mono text-xs text-text-3 tabular whitespace-nowrap">{timeOf(r.created_at)}</span>
                <span className="min-w-0 truncate text-sm font-arabic text-text-2">
                  {TYPE_LABEL[r.order_type] ?? r.order_type}
                  {where ? ` · ${where}` : ""}
                  {r.cashier_name ? <span className="text-text-muted"> · {r.cashier_name}</span> : null}
                </span>
                <span className="font-mono font-bold text-sm tabular text-text" dir="ltr">{formatMoney(r.total_cents)}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold font-arabic whitespace-nowrap ${pill.cls}`}>{pill.label}</span>
              </button>
            );
          })}
        </div>

        <div className="overflow-y-auto p-4" data-testid="history-detail">
          {!selectedId && <p className="text-sm text-text-muted font-arabic p-4 text-center">اختر طلباً لعرض تفاصيله</p>}
          {detailError && <p className="text-sm text-danger font-arabic p-4">{detailError}</p>}
          {detail && selectedId === detail.id && (
            <OrderDetail d={detail} printing={printing} canRefund={!!canRefund} onReprint={() => void reprint()} onRefund={() => setRefunding(true)} />
          )}
        </div>
      </div>

      {refunding && detail && (
        <RefundModal
          order={detail}
          isManager={isManager}
          onClose={() => setRefunding(false)}
          onDone={(o) => {
            setRefunding(false);
            toast.success(`تم استرداد ${formatMoney(o.amount_cents)} ✓`);
            void load();
            void openDetail(detail.id);
          }}
        />
      )}
      {onScreen && <OnScreenReceiptModal receiptData={onScreen} onClose={() => setOnScreen(null)} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-text-3 font-arabic shrink-0">{label}</span>
      <span className="text-text font-arabic text-left min-w-0 break-words">{children}</span>
    </div>
  );
}

function OrderDetail({ d, printing, canRefund, onReprint, onRefund }: { d: HistoryDetail; printing: boolean; canRefund: boolean; onReprint: () => void; onRefund: () => void }) {
  const pill = statusPill(d);
  const money = (c: number) => <span className="font-mono tabular" dir="ltr">{formatMoney(c)}</span>;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono font-bold text-2xl text-text" dir="ltr" data-testid="detail-number">{historyNumber(d)}</p>
          <p className="text-xs text-text-3 font-arabic mt-0.5">
            {d.business_date ? dayLabel(d.business_date) : formatArabicDate(new Date(d.created_at))}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold font-arabic ${pill.cls}`}>{pill.label}</span>
      </div>

      <div className="flex gap-2">
        {d.status === "PAID" && (
          <button onClick={onReprint} disabled={printing} data-testid="history-reprint"
            className="flex-1 h-10 rounded-sm border border-line bg-white text-sm font-arabic text-text-2 flex items-center justify-center gap-1.5 hover:bg-surface-alt disabled:opacity-50">
            <IconPrinter className="w-4 h-4" /> {printing ? "جارٍ..." : "طباعة نسخة"}
          </button>
        )}
        {canRefund && (
          <button onClick={onRefund} data-testid="history-refund"
            className="flex-1 h-10 rounded-sm border border-danger-soft text-danger text-sm font-bold font-arabic flex items-center justify-center gap-1.5 hover:bg-danger-soft">
            <IconReceiptRefund className="w-4 h-4" /> استرداد
          </button>
        )}
      </div>

      <div className="rounded-md border border-line bg-white p-3 space-y-1.5">
        <Row label="النوع">{TYPE_LABEL[d.order_type] ?? d.order_type}{d.order_type === "DINE_IN" && d.table_name ? ` · ${d.table_name}` : ""}</Row>
        {d.cashier_name && <Row label="الكاشير">{d.cashier_name}</Row>}
        {d.customer_name && <Row label="العميل">{d.customer_name}</Row>}
        {d.customer_phone && <Row label="الهاتف"><span dir="ltr">{d.customer_phone}</span></Row>}
        {d.delivery_address && <Row label="العنوان">{d.delivery_address}</Row>}
        <Row label="وقت الطلب">{timeOf(d.created_at)}</Row>
        {d.closed_at && <Row label={d.status === "PAID" ? "وقت الدفع" : "وقت الإغلاق"}>{timeOf(d.closed_at)}</Row>}
      </div>

      <div className="rounded-md border border-line bg-white divide-y divide-line">
        {d.items.map((i) => {
          const value = (i.unit_price_cents + i.modifiers.reduce((s, m) => s + m.price_cents, 0)) * i.quantity;
          return (
            <div key={i.id} className="p-3" data-testid="detail-item">
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm font-bold font-arabic text-text">{i.quantity} × {i.name}</span>
                <span className="text-sm">{i.comped ? <span className="font-arabic text-ok font-bold">ضيافة</span> : money(value)}</span>
              </div>
              {i.modifiers.length > 0 && <p className="text-xs text-text-3 font-arabic mt-0.5">{i.modifiers.map((m) => m.name).join("، ")}</p>}
              {i.notes && <p className="text-xs text-text-3 font-arabic mt-0.5">ملاحظة: {i.notes}</p>}
              {i.comped && i.comp_reason && <p className="text-xs text-text-muted font-arabic mt-0.5">{i.comp_reason}</p>}
              {i.refunded_quantity > 0 && (
                <span className="inline-block mt-1 rounded-full bg-danger-soft text-danger px-2 py-0.5 text-[11px] font-bold font-arabic" data-testid="detail-refunded-qty">مسترد ×{i.refunded_quantity}</span>
              )}
            </div>
          );
        })}
        {d.cancelled.map((c, idx) => (
          <div key={`c${idx}`} className="p-3 text-xs font-arabic text-text-muted line-through">
            {c.quantity} × {c.name}{c.reason ? ` — ${c.reason}` : ""}
          </div>
        ))}
      </div>

      <div className="rounded-md border border-line bg-white p-3 space-y-1.5">
        <Row label="المجموع الفرعي">{money(d.subtotal_cents)}</Row>
        {d.tax_cents > 0 && <Row label="الضريبة والخدمة">{money(d.tax_cents)}</Row>}
        {d.delivery_fee_cents > 0 && <Row label="رسوم التوصيل">{money(d.delivery_fee_cents)}</Row>}
        {d.discount_cents > 0 && <Row label={d.discount_reason ? `الخصم (${d.discount_reason})` : "الخصم"}><span className="font-mono" dir="ltr">-{formatMoney(d.discount_cents)}</span></Row>}
        <div className="flex items-center justify-between pt-1.5 border-t border-line">
          <span className="font-bold font-arabic text-text">الإجمالي</span>
          <span className="font-bold font-mono tabular text-lg text-text" dir="ltr">{formatMoney(d.total_cents)}</span>
        </div>
        {d.refunded_cents > 0 && <Row label="المسترد"><span className="font-mono text-danger font-bold" dir="ltr" data-testid="detail-refunded">-{formatMoney(d.refunded_cents)}</span></Row>}
      </div>

      {d.payments.length > 0 && (
        <div className="rounded-md border border-line bg-white p-3 space-y-1.5">
          <p className="text-xs font-bold font-arabic text-text-3">الدفع</p>
          {d.payments.map((p, idx) => (
            <Row key={idx} label={`${METHOD_LABEL[p.method] ?? p.method} · ${timeOf(p.created_at)}`}>
              {money(p.amount_cents - p.change_cents)}
              {p.reference_code ? <span className="text-xs text-text-muted"> · {p.reference_code}</span> : null}
            </Row>
          ))}
        </div>
      )}

      {d.refunds.length > 0 && (
        <div className="rounded-md border border-danger-soft bg-white p-3 space-y-2" data-testid="detail-refunds">
          <p className="text-xs font-bold font-arabic text-danger">المستردات</p>
          {d.refunds.map((r) => (
            <div key={r.id} className="text-sm font-arabic space-y-0.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-text">{timeOf(r.created_at)} · {r.by_name ?? "—"}{r.manager_pin_used ? " · برمز المدير" : ""}</span>
                <span className="font-mono font-bold text-danger" dir="ltr">-{formatMoney(r.amount_cents)}</span>
              </div>
              <p className="text-xs text-text-3">
                {r.lines.length > 0 ? r.lines.map((l) => `${l.quantity} × ${l.name}`).join("، ") : "الطلب كاملاً"}
                {r.method ? ` · ${METHOD_LABEL[r.method] ?? r.method}` : ""}
              </p>
              {r.reason && <p className="text-xs text-text-muted">السبب: {r.reason}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
