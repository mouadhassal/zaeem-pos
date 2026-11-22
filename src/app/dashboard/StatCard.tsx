import { IconChevronLeft } from "@tabler/icons-react";
import type { ChangeView } from "../../lib/dashboard";

const CHANGE_CLASS = {
  good: "text-ok bg-ok-soft",
  bad: "text-danger bg-danger-soft",
  neutral: "text-ink-500 bg-ink-100",
} as const;

interface Props {
  id: string;
  title: string;
  /** The one big figure. */
  value: string;
  /** One short line: what this number means. */
  hint: string;
  /** How it moved against the period before (green or red). */
  change?: ChangeView | undefined;
  /** Small extra lines under the hint (the split of a cost, the names of what is low). */
  lines?: string[] | undefined;
  /** Red or green figure when the number itself says good or bad. */
  valueTone?: "good" | "bad" | undefined;
  onOpen: () => void;
}

/** One big, plain number. Tap it to open the detailed report. */
export default function StatCard({ id, title, value, hint, change, lines, valueTone, onOpen }: Props) {
  const valueClass = valueTone === "bad" ? "text-danger" : valueTone === "good" ? "text-ok" : "text-ink-900";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`dash-card-${id}`}
      className="zc-card p-5 text-right space-y-2 hover:border-saffron-600 active:scale-[0.99] transition-colors w-full"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-base font-bold text-ink-900 font-arabic">{title}</p>
        <IconChevronLeft className="w-4 h-4 text-ink-400 shrink-0" aria-hidden />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <p className={`text-3xl font-bold font-mono ${valueClass}`}>{value}</p>
        {change && (
          <span className={`text-sm font-bold font-arabic px-2 py-0.5 rounded-md ${CHANGE_CLASS[change.tone]}`} data-testid={`dash-change-${id}`}>
            {change.text}
          </span>
        )}
      </div>
      <p className="text-sm text-ink-500 font-arabic">{hint}</p>
      {lines && lines.length > 0 && (
        <div className="text-xs text-ink-500 font-arabic space-y-0.5 pt-1 border-t border-ink-100">
          {lines.map((l) => <p key={l}>{l}</p>)}
        </div>
      )}
    </button>
  );
}
