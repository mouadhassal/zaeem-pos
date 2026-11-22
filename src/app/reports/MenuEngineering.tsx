import { useMemo } from "react";
import { useTerms } from "../../lib/terms";
import { useCurrency } from "../../hooks/useCurrency";
import { Card, ExportButtons, Note, TABLE, THEAD, Th, useReport, type ReportRange } from "./ReportParts";

type Quadrant = "star" | "workhorse" | "puzzle" | "dog" | "unknown";

interface ItemStat {
  item_id: string;
  name: string;
  category: string;
  quantity: number;
  revenue_cents: number;
  cost_cents: number;
  profit_cents: number;
  unit_profit_cents: number;
  cost_known: boolean;
  quadrant: Quadrant;
}

interface EngineeringData {
  items: ItemStat[];
  categories: { name: string; quantity: number; revenue_cents: number; cost_cents: number; profit_cents: number }[];
  addons: { name: string; times: number; revenue_cents: number }[];
  popularity_threshold: number;
  unit_profit_threshold_cents: number;
  items_without_cost: number;
}

/** The four boxes, each with the one line that says what to do about the items in it. */
export const QUADRANTS: { id: Exclude<Quadrant, "unknown">; label: string; line: string; box: string }[] = [
  { id: "star", label: "نجوم", line: "مطلوبة وربحها جيد: حافظ عليها وأبرزها.", box: "border-ok-soft bg-ok-soft" },
  { id: "workhorse", label: "أحصنة عمل", line: "مطلوبة لكن ربحها قليل: ارفع سعرها قليلاً أو خفّض تكلفتها.", box: "border-accent bg-accent-soft" },
  { id: "puzzle", label: "ألغاز", line: "ربحها جيد لكن طلبها قليل: أبرزها واقترحها على الزبائن.", box: "border-warn-soft bg-warn-soft" },
  { id: "dog", label: "ضعيفة", line: "قليلة الطلب وقليلة الربح: أعد تصميمها أو احذفها.", box: "border-danger-soft bg-danger-soft" },
];

const TOP = 10;

/** Best and worst sellers, most and least profitable, the four boxes (popularity against profit), add-on use and category profit. */
export default function MenuEngineering({ range }: { range: ReportRange }) {
  const tm = useTerms();
  const { fmt } = useCurrency();
  const { data, error, loading } = useReport<EngineeringData>("get_menu_engineering_v3", range);

  const lists = useMemo(() => {
    const items = data?.items ?? [];
    const sold = items.filter((i) => i.quantity > 0);
    const byQty = [...sold].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "ar"));
    const known = sold.filter((i) => i.cost_known);
    const byProfit = [...known].sort((a, b) => b.profit_cents - a.profit_cents || a.name.localeCompare(b.name, "ar"));
    return { best: byQty.slice(0, TOP), worst: [...byQty].reverse().slice(0, TOP), most: byProfit.slice(0, TOP), least: [...byProfit].reverse().slice(0, TOP) };
  }, [data]);

  if (error) return <Card title={`تحليل ${tm.menu}`}><Note tone="error">{error}</Note></Card>;
  if (!data) return <Card title={`تحليل ${tm.menu}`}><Note>{loading ? "جاري التحميل..." : "لا توجد بيانات"}</Note></Card>;
  if (data.items.length === 0) return <Card title={`تحليل ${tm.menu}`}><Note>لا توجد مبيعات في هذه الفترة</Note></Card>;

  const qtyHeaders = [tm.theItem, tm.category, "الكمية", "المبيعات"];
  const profitHeaders = [tm.theItem, "الكمية", "المبيعات", "التكلفة", "الربح", "ربح القطعة"];
  const qtyRows = (l: ItemStat[]) => l.map((i) => [i.name, i.category, i.quantity, i.revenue_cents]);
  const profitRows = (l: ItemStat[]) => l.map((i) => [i.name, i.quantity, i.revenue_cents, i.cost_cents, i.profit_cents, i.unit_profit_cents]);

  const SellerTable = ({ title, rows, file }: { title: string; rows: ItemStat[]; file: string }) => (
    <Card title={title} actions={<ExportButtons title={title} filename={file} headers={qtyHeaders} rows={qtyRows(rows)} moneyCols={[3]} />} testId={`menu-list-${file}`}>
      <table className={TABLE}>
        <thead className={THEAD}><tr><Th>{tm.theItem}</Th><Th end>الكمية</Th><Th end>المبيعات</Th></tr></thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.item_id} className="border-t border-ink-100">
              <td className="p-2 text-ink-900">{i.name}</td>
              <td className="p-2 text-end tabular">{i.quantity}</td>
              <td className="p-2 text-end tabular font-mono">{fmt(i.revenue_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );

  const ProfitTable = ({ title, rows, file }: { title: string; rows: ItemStat[]; file: string }) => (
    <Card title={title} actions={<ExportButtons title={title} filename={file} headers={profitHeaders} rows={profitRows(rows)} moneyCols={[2, 3, 4, 5]} />} testId={`menu-list-${file}`}>
      {rows.length === 0 ? (
        <Note>لا توجد {tm.items} لها تكلفة مسجّلة</Note>
      ) : (
        <table className={TABLE}>
          <thead className={THEAD}><tr><Th>{tm.theItem}</Th><Th end>الكمية</Th><Th end>الربح</Th><Th end>ربح القطعة</Th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.item_id} className="border-t border-ink-100">
                <td className="p-2 text-ink-900">{i.name}</td>
                <td className="p-2 text-end tabular">{i.quantity}</td>
                <td className={`p-2 text-end tabular font-mono ${i.profit_cents < 0 ? "text-danger" : ""}`}>{fmt(i.profit_cents)}</td>
                <td className="p-2 text-end tabular font-mono">{fmt(i.unit_profit_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );

  const allRows = data.items.map((i) => [i.name, i.category, i.quantity, i.revenue_cents, i.cost_cents, i.profit_cents, i.unit_profit_cents, QUADRANTS.find((q) => q.id === i.quadrant)?.label ?? "بدون تكلفة"]);

  return (
    <div className="space-y-4" data-testid="menu-engineering">
      <Card
        title={`الصناديق الأربعة: الطلب مقابل الربح`}
        hint={`كل ${tm.item} يُوضع حسب كم يُطلب (الحد: ${data.popularity_threshold} قطعة، أي 70% من نصيبه العادل) وكم يربح الواحد منه (الحد: ${fmt(data.unit_profit_threshold_cents)}، متوسط ربح القطعة في ${tm.menu}).`}
        actions={<ExportButtons title={`تحليل ${tm.menu}`} filename="تحليل-القائمة" headers={[tm.theItem, tm.category, "الكمية", "المبيعات", "التكلفة", "الربح", "ربح القطعة", "الصندوق"]} rows={allRows} moneyCols={[3, 4, 5, 6]} />}
      >
        {data.items_without_cost > 0 && (
          <p className="text-xs text-warn font-arabic bg-warn-soft rounded-sm p-2" data-testid="no-cost-note">
            {data.items_without_cost} {tm.item} بلا تكلفة مسجّلة، فلا يمكن الحكم على ربحها وهي خارج الصناديق. أدخل تكلفتها من صفحة {tm.menu}.
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="quadrants">
          {QUADRANTS.map((q) => {
            const inBox = data.items.filter((i) => i.quadrant === q.id).sort((a, b) => b.quantity - a.quantity);
            return (
              <div key={q.id} className={`rounded-md border p-3 space-y-1.5 ${q.box}`} data-testid={`quadrant-${q.id}`}>
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-ink-900 font-arabic">{q.label}</h3>
                  <span className="text-xs text-ink-500 font-arabic">{inBox.length}</span>
                </div>
                <p className="text-xs text-ink-700 font-arabic">{q.line}</p>
                <p className="text-sm text-ink-900 font-arabic">
                  {inBox.length === 0 ? <span className="text-ink-400">لا شيء هنا</span> : inBox.slice(0, 8).map((i) => i.name).join("، ") + (inBox.length > 8 ? ` و${inBox.length - 8} أخرى` : "")}
                </p>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SellerTable title={`الأكثر مبيعاً`} rows={lists.best} file="الأكثر-مبيعا" />
        <SellerTable title={`الأقل مبيعاً`} rows={lists.worst} file="الأقل-مبيعا" />
        <ProfitTable title="الأكثر ربحاً" rows={lists.most} file="الأكثر-ربحا" />
        <ProfitTable title="الأقل ربحاً" rows={lists.least} file="الأقل-ربحا" />
      </div>

      <Card
        title={`الربح حسب ${tm.category}`}
        actions={<ExportButtons title={`الربح حسب ${tm.category}`} filename="ربح-التصنيفات" headers={[tm.category, "الكمية", "المبيعات", "التكلفة", "الربح"]} rows={data.categories.map((c) => [c.name, c.quantity, c.revenue_cents, c.cost_cents, c.profit_cents])} moneyCols={[2, 3, 4]} />}
      >
        <table className={TABLE}>
          <thead className={THEAD}><tr><Th>{tm.category}</Th><Th end>الكمية</Th><Th end>المبيعات</Th><Th end>التكلفة</Th><Th end>الربح</Th></tr></thead>
          <tbody>
            {data.categories.map((c) => (
              <tr key={c.name} className="border-t border-ink-100" data-testid="category-profit-row">
                <td className="p-2 font-bold text-ink-900">{c.name}</td>
                <td className="p-2 text-end tabular">{c.quantity}</td>
                <td className="p-2 text-end tabular font-mono">{fmt(c.revenue_cents)}</td>
                <td className="p-2 text-end tabular font-mono">{fmt(c.cost_cents)}</td>
                <td className={`p-2 text-end tabular font-mono font-bold ${c.profit_cents < 0 ? "text-danger" : ""}`}>{fmt(c.profit_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="استعمال الإضافات والخيارات"
        hint="كم مرة اختار الزبائن كل إضافة، وما أضافته للمبيعات."
        actions={<ExportButtons title="استعمال الإضافات" filename="الإضافات" headers={["الإضافة", "عدد المرات", "المبلغ المضاف"]} rows={data.addons.map((a) => [a.name, a.times, a.revenue_cents])} moneyCols={[2]} />}
      >
        {data.addons.length === 0 ? (
          <Note>لم تُستعمل إضافات في هذه الفترة</Note>
        ) : (
          <table className={TABLE}>
            <thead className={THEAD}><tr><Th>الإضافة</Th><Th end>عدد المرات</Th><Th end>المبلغ المضاف</Th></tr></thead>
            <tbody>
              {data.addons.map((a) => (
                <tr key={a.name} className="border-t border-ink-100" data-testid="addon-row">
                  <td className="p-2 text-ink-900">{a.name}</td>
                  <td className="p-2 text-end tabular">{a.times}</td>
                  <td className="p-2 text-end tabular font-mono">{a.revenue_cents ? fmt(a.revenue_cents) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
