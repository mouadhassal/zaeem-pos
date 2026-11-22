import DatePicker from "../../components/ui/DatePicker";
import { DASH_PERIODS, type CustomDays, type DashPeriod } from "../../lib/dashboard";

interface Props {
  period: DashPeriod;
  custom: CustomDays;
  onPeriod: (p: DashPeriod) => void;
  onCustom: (c: CustomDays) => void;
}

/** The one period every tab follows. Days begin at 05:00, like everywhere else. */
export default function PeriodPicker({ period, custom, onPeriod, onCustom }: Props) {
  return (
    <div className="space-y-2" data-testid="dash-period">
      <div className="flex gap-2 flex-wrap">
        {DASH_PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPeriod(p.id)}
            data-testid={`dash-period-${p.id}`}
            className={`px-4 py-2 rounded-lg font-arabic text-sm font-bold transition-colors ${period === p.id ? "bg-saffron-600 text-white" : "bg-white text-ink-500 hover:bg-ink-200"}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {period === "custom" && (
        <div className="flex items-center gap-2 flex-wrap font-arabic text-sm text-ink-500">
          من
          <DatePicker value={custom.start} onChange={(v) => onCustom({ ...custom, start: v })} className="h-10 px-4 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm" />
          إلى
          <DatePicker value={custom.end} onChange={(v) => onCustom({ ...custom, end: v })} className="h-10 px-4 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm" />
        </div>
      )}
    </div>
  );
}
