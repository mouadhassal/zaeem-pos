import { useEffect, useState } from "react";
import { useTerms } from "../../lib/terms";
import { useCurrency } from "../../hooks/useCurrency";
import { usePrefsStore } from "../../stores/prefsStore";
import { formatArabicDate } from "../../lib/dateLocal";
import { Card, ExportButtons, Note, TABLE, THEAD, Th, useReport, type ReportRange } from "./ReportParts";

interface TopCustomer {
  name: string;
  phone: string;
  visits: number;
  spent_cents: number;
  avg_cents: number;
  last_visit: string | null;
}
interface InactiveCustomer {
  name: string;
  phone: string;
  last_visit: string;
  days_since: number;
  visits: number;
  spent_cents: number;
}
interface DebtBucket {
  label: string;
  debtors: number;
  amount_cents: number;
}
interface DebtorAge {
  name: string;
  phone: string;
  balance_cents: number;
  oldest_days: number;
  buckets: number[];
}
interface CustomersData {
  top: TopCustomer[];
  inactive: InactiveCustomer[];
  inactive_days: number;
  frequency: { label: string; customers: number }[];
  customers_in_period: number;
  avg_visits: number;
  unidentified_orders: number;
  debt_buckets: DebtBucket[];
  debtors: DebtorAge[];
}

const dateOnly = (iso: string | null) => (iso ? formatArabicDate(new Date(iso)) : "—");

/** Best customers, how often they come, who has gone quiet, and who owes how much for how long. */
export default function CustomersReport({ range }: { range: ReportRange }) {
  const tm = useTerms();
  const { fmt } = useCurrency();
  const days = usePrefsStore((s) => s.inactiveCustomerDays);
  const setPref = usePrefsStore((s) => s.setPref);
  const [typed, setTyped] = useState(String(days));
  useEffect(() => setTyped(String(days)), [days]);
  const commitDays = () => {
    const n = Math.round(Number(typed.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))));
    if (Number.isFinite(n) && n >= 1) setPref("inactiveCustomerDays", n);
    else setTyped(String(days));
  };
  const { data, error, loading } = useReport<CustomersData>("get_customers_report_v3", range, { inactiveDays: days });

  if (error) return <Card title={tm.customers}><Note tone="error">{error}</Note></Card>;
  if (!data) return <Card title={tm.customers}><Note>{loading ? "جاري التحميل..." : "لا توجد بيانات"}</Note></Card>;

  const topRows = data.top.map((c) => [c.name, c.phone, c.visits, c.spent_cents, c.avg_cents, c.last_visit ? dateOnly(c.last_visit) : ""]);
  const inactiveRows = data.inactive.map((c) => [c.name, c.phone, dateOnly(c.last_visit), c.days_since, c.visits, c.spent_cents]);
  const debtRows = data.debt_buckets.map((b) => [b.label, b.debtors, b.amount_cents]);
  const debtorRows = data.debtors.map((d) => [d.name, d.phone, d.balance_cents, d.oldest_days, ...d.buckets]);
  const debtorHeaders = ["المدين", "الهاتف", "الرصيد", "عمر أقدم دين (يوم)", "0 - 30", "31 - 60", "61 - 90", "أكثر من 90"];

  return (
    <div className="space-y-4" data-testid="customers-report">
      <Card
        title={`أفضل ${tm.customers}`}
        hint={`حسب ما أنفقوه في الفترة. يُعرَّف ${tm.theCustomer} برقم هاتفه أو اسمه على الطلب، فالطلبات التي لا يُسجَّل عليها ${tm.theCustomer} لا تدخل هنا (${data.unidentified_orders} طلب).`}
        actions={<ExportButtons title={`أفضل ${tm.customers}`} filename="أفضل-الزبائن" headers={[tm.customer, "الهاتف", "الزيارات", "الإنفاق", "متوسط الزيارة", "آخر زيارة"]} rows={topRows} moneyCols={[3, 4]} />}
      >
        {data.top.length === 0 ? (
          <Note>لا توجد طلبات باسم أو رقم {tm.customer} في هذه الفترة</Note>
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead className={THEAD}><tr><Th>{tm.customer}</Th><Th>الهاتف</Th><Th end>الزيارات</Th><Th end>الإنفاق</Th><Th end>متوسط الزيارة</Th><Th>آخر زيارة</Th></tr></thead>
              <tbody>
                {data.top.map((c, i) => (
                  <tr key={`${c.phone}-${c.name}-${i}`} className="border-t border-ink-100" data-testid="top-customer-row">
                    <td className="p-2 font-bold text-ink-900">{c.name}</td>
                    <td className="p-2" dir="ltr">{c.phone || "—"}</td>
                    <td className="p-2 text-end tabular">{c.visits}</td>
                    <td className="p-2 text-end tabular font-mono">{fmt(c.spent_cents)}</td>
                    <td className="p-2 text-end tabular font-mono">{fmt(c.avg_cents)}</td>
                    <td className="p-2 whitespace-nowrap">{dateOnly(c.last_visit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="تكرار الزيارات"
        hint={`${data.customers_in_period} ${tm.customer} زاروا في هذه الفترة، بمتوسط ${data.avg_visits} زيارة للواحد.`}
        actions={<ExportButtons title="تكرار الزيارات" filename="تكرار-الزيارات" headers={["عدد الزيارات", `عدد ${tm.customers}`]} rows={data.frequency.map((f) => [f.label, f.customers])} />}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="frequency">
          {data.frequency.map((f) => (
            <div key={f.label} className="rounded-sm border border-ink-200 p-3 text-center font-arabic">
              <p className="text-xs text-ink-400">{f.label}</p>
              <p className="text-xl font-bold tabular">{f.customers}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card
        title={`${tm.customers} غابوا`}
        hint={`${tm.customers} المسجّلون الذين لم يزوروا منذ المدة المحددة، الأكثر إنفاقاً أولاً: فرصة لرسالة أو عرض يعيدهم.`}
        actions={
          <>
            <label className="flex items-center gap-1.5 text-xs text-ink-500 font-arabic">
              لم يزوروا منذ
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onBlur={commitDays}
                onKeyDown={(e) => { if (e.key === "Enter") commitDays(); }}
                inputMode="numeric"
                dir="ltr"
                data-testid="inactive-days"
                className="h-8 w-16 px-2 rounded-sm border border-ink-200 text-sm text-center"
              />
              يوماً
            </label>
            <ExportButtons title={`${tm.customers} غابوا`} filename="زبائن-غابوا" headers={[tm.customer, "الهاتف", "آخر زيارة", "منذ (يوم)", "الزيارات", "إجمالي الإنفاق"]} rows={inactiveRows} moneyCols={[5]} />
          </>
        }
      >
        {data.inactive.length === 0 ? (
          <Note>لا يوجد {tm.customer} غاب أكثر من {data.inactive_days} يوماً</Note>
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead className={THEAD}><tr><Th>{tm.customer}</Th><Th>الهاتف</Th><Th>آخر زيارة</Th><Th end>منذ (يوم)</Th><Th end>الزيارات</Th><Th end>إجمالي الإنفاق</Th></tr></thead>
              <tbody>
                {data.inactive.map((c, i) => (
                  <tr key={`${c.phone}-${i}`} className="border-t border-ink-100" data-testid="inactive-row">
                    <td className="p-2 font-bold text-ink-900">{c.name}</td>
                    <td className="p-2" dir="ltr">{c.phone}</td>
                    <td className="p-2 whitespace-nowrap">{dateOnly(c.last_visit)}</td>
                    <td className="p-2 text-end tabular">{c.days_since}</td>
                    <td className="p-2 text-end tabular">{c.visits}</td>
                    <td className="p-2 text-end tabular font-mono">{fmt(c.spent_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="الديون حسب العمر"
        hint="كم على الزبائن ومنذ متى. التسديد يُحسب من أقدم دين أولاً. هذا الجدول للوضع الحالي ولا يتأثر بالفترة المختارة."
        actions={<ExportButtons title="الديون حسب العمر" filename="الديون-حسب-العمر" headers={["العمر", "عدد المدينين", "المبلغ"]} rows={debtRows} moneyCols={[2]} />}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="debt-buckets">
          {data.debt_buckets.map((b) => (
            <div key={b.label} className="rounded-sm border border-ink-200 p-3 text-center font-arabic">
              <p className="text-xs text-ink-400">{b.label}</p>
              <p className="text-lg font-bold tabular font-mono">{fmt(b.amount_cents)}</p>
              <p className="text-xs text-ink-500">{b.debtors} مدين</p>
            </div>
          ))}
        </div>
        {data.debtors.length === 0 ? (
          <Note>لا توجد ديون مستحقة</Note>
        ) : (
          <>
            <div className="flex justify-end gap-2"><ExportButtons title="المدينون" filename="المدينون" headers={debtorHeaders} rows={debtorRows} moneyCols={[2, 4, 5, 6, 7]} /></div>
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead className={THEAD}><tr>{debtorHeaders.map((h, i) => <Th key={h} end={i >= 2}>{h}</Th>)}</tr></thead>
                <tbody>
                  {data.debtors.map((d, i) => (
                    <tr key={`${d.phone}-${i}`} className="border-t border-ink-100" data-testid="debtor-row">
                      <td className="p-2 font-bold text-ink-900">{d.name}</td>
                      <td className="p-2" dir="ltr">{d.phone || "—"}</td>
                      <td className="p-2 text-end tabular font-mono">{fmt(d.balance_cents)}</td>
                      <td className={`p-2 text-end tabular ${d.oldest_days > 90 ? "text-danger font-bold" : ""}`}>{d.oldest_days}</td>
                      {d.buckets.map((b, j) => <td key={j} className="p-2 text-end tabular font-mono text-ink-500">{b ? fmt(b) : "—"}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
