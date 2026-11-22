import { barHeights, type BarPoint, type SplitPart } from "../../lib/dashboard";

/** Plain bars drawn with CSS (the app has no chart library). Each bar has its figure on hover. */
export function BarChart({ title, points, fmt }: { title: string; points: BarPoint[]; fmt: (v: number) => string }) {
  const heights = barHeights(points);
  if (points.length === 0 || heights.every((h) => h === 0)) return null;
  return (
    <div className="zc-card p-4 space-y-2" data-testid="dash-chart">
      <p className="text-sm font-bold text-ink-900 font-arabic">{title}</p>
      <div className="flex items-end gap-1 h-40" dir="ltr">
        {points.map((p, i) => (
          <div key={`${p.label}-${i}`} className="flex-1 min-w-0 h-full flex flex-col justify-end" title={`${p.label}: ${fmt(p.value)}`}>
            <div className="w-full rounded-t bg-saffron-600" style={{ height: `${heights[i]}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-1 text-[10px] text-ink-400 font-mono" dir="ltr">
        {points.map((p, i) => (
          <span key={`${p.label}-${i}`} className="flex-1 min-w-0 text-center truncate">{points.length > 16 && i % 2 === 1 ? "" : p.label}</span>
        ))}
      </div>
    </div>
  );
}

const PART_CLASS: Record<SplitPart["id"], string> = {
  goods: "bg-warn",
  salaries: "bg-saffron-600",
  other: "bg-ink-400",
  profit: "bg-ok",
};

/** One bar for the sales: how much of them went to goods, salaries, other costs, and what is left. */
export function SplitBar({ title, parts, fmt }: { title: string; parts: SplitPart[]; fmt: (v: number) => string }) {
  if (parts.length === 0) return null;
  return (
    <div className="zc-card p-4 space-y-3" data-testid="dash-split">
      <p className="text-sm font-bold text-ink-900 font-arabic">{title}</p>
      <div className="flex h-5 rounded-md overflow-hidden" dir="rtl">
        {parts.map((p) => <div key={p.id} className={PART_CLASS[p.id]} style={{ width: `${p.pct}%` }} title={`${p.label} ${p.pct}%`} />)}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm font-arabic text-ink-900">
        {parts.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1.5">
            <span className={`w-3 h-3 rounded-sm ${PART_CLASS[p.id]}`} />
            {p.label}: <span className="font-mono font-bold">{fmt(p.cents)}</span> <span className="text-ink-500">({p.pct}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}
