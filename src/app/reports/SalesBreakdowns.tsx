import { useMemo, useState } from "react";
import { useTerms } from "../../lib/terms";
import { useBusinessStore } from "../../stores/businessStore";
import { useCurrency } from "../../hooks/useCurrency";
import { formatArabicDateTime } from "../../lib/dateLocal";
import { changeOf, previousRange, withComparison, type BreakdownLike } from "../../lib/reportMath";
import DrillDown, { type DrillTarget } from "./DrillDown";
import { Card, ChangeBadge, ExportButtons, Note, ShareBar, TABLE, THEAD, Th, useReport, type ReportRange } from "./ReportParts";

interface Breakdown {
  kind: string;
  rows: BreakdownLike[];
  total_count: number;
  total_cents: number;
}

interface CancelledOrder {
  order_id: string;
  number: string | null;
  when: string;
  who: string | null;
  reason: string | null;
  value_cents: number;
}

interface VoidedItem {
  order_id: string;
  number: string | null;
  name: string;
  quantity: number;
  value_cents: number;
  when: string;
  who: string | null;
  reason: string | null;
}

interface Cancellations {
  cancelled: CancelledOrder[];
  voided: VoidedItem[];
  cancelled_total_cents: number;
  voided_total_cents: number;
}

type Kind = "hour" | "table" | "area" | "cashier" | "source" | "payment" | "discount_user" | "discount_reason" | "cancellations";

/** Sales for the period split one way, each row with its share and its change against the previous period; tap a row for its orders. */
export default function SalesBreakdowns({ range }: { range: ReportRange }) {
  const tm = useTerms();
  const hasTables = useBusinessStore((s) => s.hasTables);
  const [kind, setKind] = useState<Kind>("hour");
  const [drill, setDrill] = useState<DrillTarget | null>(null);

  const kinds: { id: Kind; label: string; col: string; show: boolean }[] = [
    { id: "hour", label: "حسب الساعة", col: "الساعة", show: true },
    { id: "table", label: `حسب ${tm.table}`, col: tm.table, show: hasTables },
    { id: "area", label: "حسب المنطقة", col: "المنطقة", show: hasTables },
    { id: "cashier", label: "حسب الكاشير", col: "الكاشير", show: true },
    { id: "source", label: "حسب مصدر الطلب", col: "المصدر", show: true },
    { id: "payment", label: "طرق الدفع", col: "الطريقة", show: true },
    { id: "discount_user", label: "الخصومات حسب الشخص", col: "الشخص", show: true },
    { id: "discount_reason", label: "الخصومات حسب السبب", col: "السبب", show: true },
    { id: "cancellations", label: "الملغي والمحذوف", col: "", show: true },
  ];
  const active = kinds.find((k) => k.id === kind && k.show) ?? kinds[0];

  return (
    <Card title="تفصيل المبيعات" hint="اضغط على أي سطر لترى الطلبات التي كوّنته. المقارنة مع الفترة السابقة بالطول نفسه.">
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {kinds.filter((k) => k.show).map((k) => (
          <button
            key={k.id}
            type="button"
            role="tab"
            aria-selected={active.id === k.id}
            onClick={() => setKind(k.id)}
            data-testid={`breakdown-kind-${k.id}`}
            className={`h-8 px-3 rounded-full text-xs font-bold font-arabic ${active.id === k.id ? "bg-ink-900 text-white" : "bg-surface-alt text-ink-500 hover:bg-ink-100"}`}
          >
            {k.label}
          </button>
        ))}
      </div>
      {active.id === "cancellations" ? (
        <CancellationsTable range={range} onOpen={(orderId, title) => setDrill({ title, orderId })} />
      ) : (
        <BreakdownTable key={active.id} kind={active.id} label={active.label} column={active.col} range={range} onOpen={(key, label) => setDrill({ title: `${active.label}: ${label}`, kind: active.id, key })} />
      )}
      {drill && <DrillDown target={drill} range={range} onClose={() => setDrill(null)} />}
    </Card>
  );
}

function BreakdownTable({ kind, label, column, range, onOpen }: { kind: string; label: string; column: string; range: ReportRange; onOpen: (key: string, label: string) => void }) {
  const { fmt } = useCurrency();
  const prevRange = useMemo(() => ({ ...previousRange(range.startIso, range.endIso), tz: range.tz }), [range.startIso, range.endIso, range.tz]);
  const cur = useReport<Breakdown>("get_sales_breakdown_v3", range, { kind });
  const prev = useReport<Breakdown>("get_sales_breakdown_v3", { startIso: prevRange.startIso, endIso: prevRange.endIso, tz: range.tz }, { kind });
  const isDiscount = kind.startsWith("discount");

  const rows = useMemo(() => withComparison(cur.data?.rows ?? [], prev.data?.rows ?? null), [cur.data, prev.data]);
  const total = cur.data?.total_cents ?? 0;
  const totalChange = changeOf(total, prev.data?.total_cents ?? 0);
  const countText = "الطلبات";

  const exportRows = rows.map((r) => [r.label, r.count, r.amount_cents, `${r.share}%`, r.previous_cents, r.change.pct === null ? "جديد" : `${r.change.pct}%`]);
  const headers = [column, countText, "القيمة", "النسبة من الإجمالي", "الفترة السابقة", "التغيير"];

  return (
    <div className="space-y-2" data-testid="breakdown-table">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-ink-400 font-arabic">
          {isDiscount ? "قيمة الخصومات" : "قيمة الطلبات المدفوعة قبل المرتجعات"} · {cur.data?.total_count ?? 0} طلب
        </p>
        <div className="flex gap-2">
          <ExportButtons title={label} filename={`تفصيل-${kind}`} headers={headers} rows={exportRows} moneyCols={[2, 4]} />
        </div>
      </div>
      {cur.error && <Note tone="error">{cur.error}</Note>}
      {cur.loading && !cur.data && <Note>جاري التحميل...</Note>}
      {cur.data && rows.length === 0 && <Note>لا توجد بيانات في هذه الفترة</Note>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead className={THEAD}>
              <tr>
                <Th>{column}</Th>
                <Th end>{countText}</Th>
                <Th end>القيمة</Th>
                <Th>النسبة</Th>
                <Th end>الفترة السابقة</Th>
                <Th>التغيير</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} onClick={() => onOpen(r.key, r.label)} className="border-t border-ink-100 cursor-pointer hover:bg-surface-alt" data-testid="breakdown-row">
                  <td className="p-2 font-bold text-ink-900">{r.label}</td>
                  <td className="p-2 text-end tabular">{r.count}</td>
                  <td className="p-2 text-end tabular font-mono">{fmt(r.amount_cents)}</td>
                  <td className="p-2"><ShareBar pct={r.share} /></td>
                  <td className="p-2 text-end tabular font-mono text-ink-500">{fmt(r.previous_cents)}</td>
                  <td className="p-2"><ChangeBadge change={r.change} higherIsBetter={!isDiscount} /></td>
                </tr>
              ))}
              <tr className="border-t-2 border-ink-200 font-bold">
                <td className="p-2">الإجمالي</td>
                <td className="p-2 text-end tabular">{cur.data?.total_count ?? 0}</td>
                <td className="p-2 text-end tabular font-mono">{fmt(total)}</td>
                <td className="p-2" />
                <td className="p-2 text-end tabular font-mono text-ink-500">{fmt(prev.data?.total_cents ?? 0)}</td>
                <td className="p-2"><ChangeBadge change={totalChange} higherIsBetter={!isDiscount} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CancellationsTable({ range, onOpen }: { range: ReportRange; onOpen: (orderId: string, title: string) => void }) {
  const { fmt } = useCurrency();
  const prevRange = useMemo(() => ({ ...previousRange(range.startIso, range.endIso), tz: range.tz }), [range.startIso, range.endIso, range.tz]);
  const cur = useReport<Cancellations>("get_cancellations_report_v3", range);
  const prev = useReport<Cancellations>("get_cancellations_report_v3", prevRange);
  const d = cur.data;

  const orderRows = (d?.cancelled ?? []).map((o) => [o.number ?? "", formatArabicDateTime(new Date(o.when)), o.who ?? "غير مسجل", o.reason ?? "", o.value_cents]);
  const itemRows = (d?.voided ?? []).map((v) => [v.number ?? "", formatArabicDateTime(new Date(v.when)), v.name, v.quantity, v.who ?? "غير مسجل", v.reason ?? "", v.value_cents]);

  return (
    <div className="space-y-4" data-testid="cancellations">
      {cur.error && <Note tone="error">{cur.error}</Note>}
      {cur.loading && !d && <Note>جاري التحميل...</Note>}
      {d && (
        <div className="grid grid-cols-2 gap-3 text-sm font-arabic">
          <div className="rounded-sm border border-ink-200 p-3 space-y-1">
            <p className="text-ink-400 text-xs">طلبات ملغاة</p>
            <p className="font-bold text-lg tabular">{d.cancelled.length} · <span className="font-mono">{fmt(d.cancelled_total_cents)}</span></p>
            <ChangeBadge change={changeOf(d.cancelled_total_cents, prev.data?.cancelled_total_cents ?? 0)} higherIsBetter={false} />
          </div>
          <div className="rounded-sm border border-ink-200 p-3 space-y-1">
            <p className="text-ink-400 text-xs">أصناف محذوفة من طلبات</p>
            <p className="font-bold text-lg tabular">{d.voided.length} · <span className="font-mono">{fmt(d.voided_total_cents)}</span></p>
            <ChangeBadge change={changeOf(d.voided_total_cents, prev.data?.voided_total_cents ?? 0)} higherIsBetter={false} />
          </div>
        </div>
      )}
      {d && (
        <>
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-ink-900 font-arabic text-sm">الطلبات الملغاة</h3>
            <div className="flex gap-2"><ExportButtons title="الطلبات الملغاة" filename="الطلبات-الملغاة" headers={["الرقم", "الوقت", "من ألغاه", "السبب", "القيمة"]} rows={orderRows} moneyCols={[4]} /></div>
          </div>
          {d.cancelled.length === 0 ? (
            <Note>لا توجد طلبات ملغاة في هذه الفترة</Note>
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead className={THEAD}><tr><Th>الرقم</Th><Th>الوقت</Th><Th>من ألغاه</Th><Th>السبب</Th><Th end>القيمة</Th></tr></thead>
                <tbody>
                  {d.cancelled.map((o) => (
                    <tr key={o.order_id} onClick={() => onOpen(o.order_id, `طلب ملغى ${o.number ?? ""}`)} className="border-t border-ink-100 cursor-pointer hover:bg-surface-alt" data-testid="cancelled-row">
                      <td className="p-2 font-mono" dir="ltr">{o.number ?? "—"}</td>
                      <td className="p-2 whitespace-nowrap">{formatArabicDateTime(new Date(o.when))}</td>
                      <td className="p-2">{o.who ?? <span className="text-ink-400">غير مسجل</span>}</td>
                      <td className="p-2">{o.reason ?? "—"}</td>
                      <td className="p-2 text-end tabular font-mono">{fmt(o.value_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-ink-900 font-arabic text-sm">الأصناف المحذوفة</h3>
            <div className="flex gap-2"><ExportButtons title="الأصناف المحذوفة" filename="الأصناف-المحذوفة" headers={["الطلب", "الوقت", "الصنف", "الكمية", "من حذفه", "السبب", "القيمة"]} rows={itemRows} moneyCols={[6]} /></div>
          </div>
          {d.voided.length === 0 ? (
            <Note>لا توجد أصناف محذوفة في هذه الفترة</Note>
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead className={THEAD}><tr><Th>الطلب</Th><Th>الوقت</Th><Th>الصنف</Th><Th end>الكمية</Th><Th>من حذفه</Th><Th>السبب</Th><Th end>القيمة</Th></tr></thead>
                <tbody>
                  {d.voided.map((v, i) => (
                    <tr key={`${v.order_id}-${i}`} onClick={() => onOpen(v.order_id, `طلب ${v.number ?? ""}`)} className="border-t border-ink-100 cursor-pointer hover:bg-surface-alt" data-testid="voided-row">
                      <td className="p-2 font-mono" dir="ltr">{v.number ?? "—"}</td>
                      <td className="p-2 whitespace-nowrap">{formatArabicDateTime(new Date(v.when))}</td>
                      <td className="p-2">{v.name}</td>
                      <td className="p-2 text-end tabular">{v.quantity}</td>
                      <td className="p-2">{v.who ?? <span className="text-ink-400">غير مسجل</span>}</td>
                      <td className="p-2">{v.reason ?? "—"}</td>
                      <td className="p-2 text-end tabular font-mono">{fmt(v.value_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
