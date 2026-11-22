import { useEffect, useState } from "react";
import { useTerms } from "../../lib/terms";
import { useCurrency } from "../../hooks/useCurrency";
import { usePrefsStore } from "../../stores/prefsStore";
import { formatArabicDateTime } from "../../lib/dateLocal";
import DrillDown, { type DrillTarget } from "./DrillDown";
import { Card, ExportButtons, Note, TABLE, THEAD, Th, useReport, type ReportRange } from "./ReportParts";

interface KitchenData {
  prep: { count: number; avg_minutes: number; median_minutes: number; max_minutes: number; late_count: number; late_minutes: number };
  late_orders: { order_id: string; number: string | null; order_type: string; created_at: string; minutes: number }[];
  stations: { name: string; count: number; avg_minutes: number; late_count: number }[];
  delivery: { count: number; avg_minutes: number; median_minutes: number; max_minutes: number; failed: number };
  drivers: { name: string; count: number; avg_minutes: number }[];
  apps: { name: string; count: number; amount_cents: number }[];
}

const TYPE: Record<string, string> = { DINE_IN: "صالة", TAKEAWAY: "سفري", DELIVERY: "توصيل", ONLINE: "أونلاين" };
const min = (m: number) => `${m} د`;

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" | undefined }) {
  return (
    <div className="rounded-sm border border-ink-200 p-3 text-center font-arabic">
      <p className="text-xs text-ink-400">{label}</p>
      <p className={`text-xl font-bold tabular ${tone === "bad" ? "text-danger" : "text-ink-900"}`}>{value}</p>
    </div>
  );
}

/** How fast the kitchen gets orders ready (late ones over the owner's limit), how fast the drivers deliver, and orders per delivery app. */
export default function KitchenDeliveryReport({ range }: { range: ReportRange }) {
  const tm = useTerms();
  const { fmt } = useCurrency();
  const late = usePrefsStore((s) => s.kitchenLateMinutes);
  const setPref = usePrefsStore((s) => s.setPref);
  const [typed, setTyped] = useState(String(late));
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  useEffect(() => setTyped(String(late)), [late]);
  const commit = () => {
    const n = Math.round(Number(typed.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))));
    if (Number.isFinite(n) && n >= 1) setPref("kitchenLateMinutes", n);
    else setTyped(String(late));
  };
  const { data, error, loading } = useReport<KitchenData>("get_kitchen_delivery_report_v3", range, { lateMinutes: late });

  if (error) return <Card title={`${tm.kitchen} والتوصيل`}><Note tone="error">{error}</Note></Card>;
  if (!data) return <Card title={`${tm.kitchen} والتوصيل`}><Note>{loading ? "جاري التحميل..." : "لا توجد بيانات"}</Note></Card>;
  const { prep, delivery } = data;

  return (
    <div className="space-y-4" data-testid="kitchen-report">
      <Card
        title={`وقت التحضير في ${tm.kitchen}`}
        hint={`من وصول الطلب إلى ${tm.kitchen} حتى يصبح «جاهزاً» في شاشة ${tm.kitchen}. لا يُحسب إلا ما مرّ على شاشة ${tm.kitchen}، والطلبات الهاتفية المجدولة مستثناة.`}
        actions={
          <label className="flex items-center gap-1.5 text-xs text-ink-500 font-arabic">
            المتأخر: أكثر من
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
              inputMode="numeric"
              dir="ltr"
              data-testid="late-minutes"
              className="h-8 w-14 px-2 rounded-sm border border-ink-200 text-sm text-center"
            />
            دقيقة
          </label>
        }
      >
        {prep.count === 0 ? (
          <Note>لا توجد طلبات مرّت على شاشة {tm.kitchen} في هذه الفترة</Note>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3" data-testid="prep-stats">
            <Stat label="عدد الطلبات" value={String(prep.count)} />
            <Stat label="متوسط التحضير" value={min(prep.avg_minutes)} />
            <Stat label="الوسيط" value={min(prep.median_minutes)} />
            <Stat label="الأطول" value={min(prep.max_minutes)} />
            <Stat label={`متأخر (> ${prep.late_minutes} د)`} value={`${prep.late_count}`} tone={prep.late_count > 0 ? "bad" : undefined} />
          </div>
        )}
      </Card>

      {data.late_orders.length > 0 && (
        <Card
          title="الطلبات المتأخرة"
          hint="الأطول أولاً، حتى 30 طلباً. اضغط على الطلب لتراه."
          actions={<ExportButtons title="الطلبات المتأخرة" filename="الطلبات-المتأخرة" headers={["الرقم", "النوع", "الوقت", "مدة التحضير (د)"]} rows={data.late_orders.map((o) => [o.number ?? "", TYPE[o.order_type] ?? o.order_type, formatArabicDateTime(new Date(o.created_at)), o.minutes])} />}
        >
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead className={THEAD}><tr><Th>الرقم</Th><Th>النوع</Th><Th>الوقت</Th><Th end>مدة التحضير</Th></tr></thead>
              <tbody>
                {data.late_orders.map((o) => (
                  <tr key={o.order_id} onClick={() => setDrill({ title: `طلب ${o.number ?? ""}`, orderId: o.order_id })} className="border-t border-ink-100 cursor-pointer hover:bg-surface-alt" data-testid="late-row">
                    <td className="p-2 font-mono" dir="ltr">{o.number ?? "—"}</td>
                    <td className="p-2">{TYPE[o.order_type] ?? o.order_type}</td>
                    <td className="p-2 whitespace-nowrap">{formatArabicDateTime(new Date(o.created_at))}</td>
                    <td className="p-2 text-end tabular text-danger font-bold">{min(o.minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {data.stations.length > 0 && (
        <Card
          title={`حسب قسم ${tm.kitchen}`}
          hint="الأقسام هي طابعات المطبخ التي حددتَ لها فئات. الطلب الذي فيه أصناف من عدة أقسام يُحسب لكل قسم منها، فالأرقام تقريبية."
          actions={<ExportButtons title={`حسب قسم ${tm.kitchen}`} filename="أقسام-المطبخ" headers={["القسم", "الطلبات", "متوسط التحضير (د)", "المتأخر"]} rows={data.stations.map((s) => [s.name, s.count, s.avg_minutes, s.late_count])} />}
        >
          <table className={TABLE}>
            <thead className={THEAD}><tr><Th>القسم</Th><Th end>الطلبات</Th><Th end>متوسط التحضير</Th><Th end>المتأخر</Th></tr></thead>
            <tbody>
              {data.stations.map((s) => (
                <tr key={s.name} className="border-t border-ink-100" data-testid="station-row">
                  <td className="p-2 font-bold text-ink-900">{s.name}</td>
                  <td className="p-2 text-end tabular">{s.count}</td>
                  <td className="p-2 text-end tabular">{min(s.avg_minutes)}</td>
                  <td className="p-2 text-end tabular">{s.late_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="زمن التوصيل" hint="من خروج الطلب مع السائق «خرج للتوصيل» حتى تسجيل «تم التسليم».">
        {delivery.count === 0 && delivery.failed === 0 ? (
          <Note>لا توجد توصيلات مكتملة في هذه الفترة</Note>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3" data-testid="delivery-stats">
            <Stat label="توصيلات مكتملة" value={String(delivery.count)} />
            <Stat label="متوسط الزمن" value={min(delivery.avg_minutes)} />
            <Stat label="الوسيط" value={min(delivery.median_minutes)} />
            <Stat label="الأطول" value={min(delivery.max_minutes)} />
            <Stat label="فاشلة" value={String(delivery.failed)} tone={delivery.failed > 0 ? "bad" : undefined} />
          </div>
        )}
        {data.drivers.length > 0 && (
          <>
            <div className="flex justify-end gap-2"><ExportButtons title="زمن التوصيل حسب السائق" filename="زمن-التوصيل" headers={["السائق", "التوصيلات", "متوسط الزمن (د)"]} rows={data.drivers.map((d) => [d.name, d.count, d.avg_minutes])} /></div>
            <table className={TABLE}>
              <thead className={THEAD}><tr><Th>السائق</Th><Th end>التوصيلات</Th><Th end>متوسط الزمن</Th></tr></thead>
              <tbody>
                {data.drivers.map((d) => (
                  <tr key={d.name} className="border-t border-ink-100" data-testid="driver-row">
                    <td className="p-2 font-bold text-ink-900">{d.name}</td>
                    <td className="p-2 text-end tabular">{d.count}</td>
                    <td className="p-2 text-end tabular">{min(d.avg_minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>

      <Card
        title="الطلبات حسب تطبيق التوصيل"
        hint="الطلبات المدفوعة التي جاءت من تطبيق توصيل، بعددها وقيمتها."
        actions={<ExportButtons title="الطلبات حسب تطبيق التوصيل" filename="تطبيقات-التوصيل" headers={["التطبيق", "الطلبات", "القيمة"]} rows={data.apps.map((a) => [a.name, a.count, a.amount_cents])} moneyCols={[2]} />}
      >
        {data.apps.length === 0 ? (
          <Note>لا توجد طلبات من تطبيقات توصيل في هذه الفترة</Note>
        ) : (
          <table className={TABLE}>
            <thead className={THEAD}><tr><Th>التطبيق</Th><Th end>الطلبات</Th><Th end>القيمة</Th></tr></thead>
            <tbody>
              {data.apps.map((a) => (
                <tr key={a.name} className="border-t border-ink-100" data-testid="app-row">
                  <td className="p-2 font-bold text-ink-900">{a.name}</td>
                  <td className="p-2 text-end tabular">{a.count}</td>
                  <td className="p-2 text-end tabular font-mono">{fmt(a.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {drill && <DrillDown target={drill} range={range} onClose={() => setDrill(null)} />}
    </div>
  );
}
