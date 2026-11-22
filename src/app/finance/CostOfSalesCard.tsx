import { useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { formatMoney } from "../../lib/money";
import { costClassLabel, formatBp, tzOffsetMinutes } from "../../lib/profit";

interface ClassCost {
  class: string;
  cost_cents: number;
  bp: number;
}

interface CostOfSales {
  net_sales_cents: number;
  classes: ClassCost[];
  total_cost_cents: number;
  total_bp: number;
  labour_cents: number;
  labour_bp: number;
}

interface Props {
  token: string | null;
  startIso: string;
  endIso: string;
}

/** "تكلفة المواد": what the items sold cost, per cost class, and labour, each as a share of net sales. */
export default function CostOfSalesCard({ token, startIso, endIso }: Props) {
  const [data, setData] = useState<CostOfSales | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    setError(false);
    invoke<CostOfSales>("get_cost_of_sales_v3", { sessionToken: token, startIso, endIso, tzOffsetMinutes: tzOffsetMinutes() })
      .then((d) => live && setData(d))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [token, startIso, endIso]);

  if (error) return null;
  if (!data) return null;
  const rows = data.classes.filter((c) => c.cost_cents > 0 || c.class === "FOOD");
  return (
    <div className="zc-card p-4 space-y-3" data-testid="cost-of-sales">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-bold text-ink-900 font-arabic">تكلفة المواد</h2>
        <p className="text-[11px] text-ink-400 font-arabic">كنسبة من صافي المبيعات {formatMoney(data.net_sales_cents)}</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {rows.map((c) => (
          <div key={c.class} className="rounded-md border border-ink-200 p-3" data-testid={`cos-${c.class}`}>
            <p className="text-xs text-ink-400 font-arabic">{costClassLabel(c.class)}</p>
            <p className="font-mono font-bold text-ink-900">{formatMoney(c.cost_cents)}</p>
            <p className="text-sm font-mono text-saffron-600">{formatBp(c.bp)}</p>
          </div>
        ))}
        <div className="rounded-md border border-ink-200 p-3 bg-surface-alt" data-testid="cos-total">
          <p className="text-xs text-ink-400 font-arabic">كل تكلفة المواد</p>
          <p className="font-mono font-bold text-ink-900">{formatMoney(data.total_cost_cents)}</p>
          <p className="text-sm font-mono text-saffron-600">{formatBp(data.total_bp)}</p>
        </div>
        <div className="rounded-md border border-ink-200 p-3" data-testid="cos-labour">
          <p className="text-xs text-ink-400 font-arabic">العمالة (الرواتب)</p>
          <p className="font-mono font-bold text-ink-900">{formatMoney(data.labour_cents)}</p>
          <p className="text-sm font-mono text-saffron-600">{formatBp(data.labour_bp)}</p>
        </div>
      </div>
      <p className="text-[11px] text-ink-400 font-arabic">
        التصنيف من «القائمة» ← تعديل التصنيف ← «نوع التكلفة». بلا اختيار يُحسب «مأكولات».
      </p>
    </div>
  );
}
