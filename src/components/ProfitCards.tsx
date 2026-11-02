import { useState } from "react";
import { IconInfoCircle, IconAlertTriangle } from "@tabler/icons-react";
import { navigateTo } from "../lib/appNav";
import { formatMarginPercent, PROFIT_EXPLAINER, PROFIT_EXPLAINER_INTRO, REFUND_NOTE, type ProfitSummary } from "../lib/profit";

interface Props {
  profit: ProfitSummary;
  fmt: (cents: number) => string;
}

function signClass(v: number) {
  return v >= 0 ? "text-ok" : "text-danger";
}

/**
 * Net sales and the three ways to read profit, each with its formula on the
 * card, a warning when item costs are missing, and a "how is this counted?"
 * panel for people who have never seen these terms.
 */
export default function ProfitCards({ profit, fmt }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3" data-testid="profit-cards">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="zc-card p-4 space-y-1" data-testid="profit-net-sales">
          <p className="text-ink-400 text-sm font-arabic">صافي المبيعات</p>
          <p className="text-2xl font-bold text-saffron-600 font-mono">{fmt(profit.net_sales_cents)}</p>
          <p className="text-[11px] text-ink-400 font-arabic">
            المبيعات {fmt(profit.gross_sales_cents)}
            {profit.refunds_cents > 0 ? ` − المرتجعات ${fmt(profit.refunds_cents)}` : ""}
          </p>
        </div>
        <div className="zc-card p-4 space-y-1" data-testid="profit-margin">
          <p className="text-ink-400 text-sm font-arabic">ربح الهامش</p>
          <p className={`text-2xl font-bold font-mono ${signClass(profit.margin_profit_cents)}`}>{fmt(profit.margin_profit_cents)}</p>
          <p className="text-[11px] text-ink-400 font-arabic">
            هامش {formatMarginPercent(profit.margin_bp)} · بعد تكلفة الأصناف {fmt(profit.cogs_cents)}
          </p>
        </div>
        <div className="zc-card p-4 space-y-1" data-testid="profit-expenses">
          <p className="text-ink-400 text-sm font-arabic">الربح بالمصروفات</p>
          <p className={`text-2xl font-bold font-mono ${signClass(profit.expense_profit_cents)}`}>{fmt(profit.expense_profit_cents)}</p>
          <p className="text-[11px] text-ink-400 font-arabic">بعد كل المصروفات المسجلة {fmt(profit.expenses_cents)}</p>
        </div>
        <div className="zc-card p-4 space-y-1" data-testid="profit-net">
          <p className="text-ink-400 text-sm font-arabic">صافي الربح الفعلي</p>
          <p className={`text-2xl font-bold font-mono ${signClass(profit.net_profit_cents)}`}>{fmt(profit.net_profit_cents)}</p>
          <p className="text-[11px] text-ink-400 font-arabic">
            ربح الهامش − إيجار ورواتب وفواتير {fmt(profit.operating_expenses_cents)}
            {profit.salaries_cents > 0 ? ` (منها رواتب ${fmt(profit.salaries_cents)})` : ""}
          </p>
        </div>
      </div>

      {profit.items_without_cost > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warn bg-warn-soft p-3 text-sm font-arabic text-ink-900" data-testid="profit-missing-cost">
          <IconAlertTriangle className="w-5 h-5 text-warn shrink-0 mt-0.5" />
          <div className="flex-1">
            {profit.items_without_cost === 1 ? "صنف واحد" : `${profit.items_without_cost} أصناف`} مبيعة بلا «تكلفة» مُدخلة، فيبدو ربح الهامش أعلى من الحقيقة.
            أدخل التكلفة من «القائمة» وسيُحسب الربح تلقائياً.
          </div>
          <button onClick={() => navigateTo("menu")} className="shrink-0 text-saffron-600 font-bold hover:text-saffron-700">فتح القائمة</button>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-sm text-saffron-600 hover:text-saffron-700 font-arabic font-bold"
        data-testid="profit-explain-toggle"
      >
        <IconInfoCircle className="w-4 h-4" />
        {open ? "إخفاء الشرح" : "كيف تُحسب هذه الأرقام؟"}
      </button>
      {open && (
        <div className="zc-card p-4 space-y-3 text-sm font-arabic text-ink-900" data-testid="profit-explainer">
          <p className="font-bold">{PROFIT_EXPLAINER_INTRO}</p>
          {PROFIT_EXPLAINER.map((item, i) => (
            <div key={item.title} className="space-y-0.5">
              <p className="font-bold">{i + 1}) {item.title} = <span className="text-saffron-600">{item.formula}</span></p>
              <p className="text-ink-500">{item.text}</p>
            </div>
          ))}
          <p className="text-ink-500">{REFUND_NOTE}</p>
        </div>
      )}
    </div>
  );
}
