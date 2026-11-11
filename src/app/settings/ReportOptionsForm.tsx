import { usePrefsStore } from "../../stores/prefsStore";
import { REPORT_OPTION_LABELS, DEFAULT_REPORT_OPTIONS, type ReportOptions } from "../../lib/reportOptions";

/**
 * The switches that decide what the long printed sales report contains.
 * Used in Settings > التفضيلات والتصميم and in the print dialog of the
 * Reports page, so the owner sees and changes the same choice in both.
 */
export default function ReportOptionsForm() {
  const options = usePrefsStore((s) => s.reportOptions);
  const setPref = usePrefsStore((s) => s.setPref);
  const set = (key: keyof ReportOptions, value: boolean) => setPref("reportOptions", { ...options, [key]: value });

  return (
    <div className="space-y-3" data-testid="report-options">
      {REPORT_OPTION_LABELS.map(({ key, label, hint }) => {
        const on = options[key];
        return (
          <div key={key} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <span className="text-sm font-arabic text-ink-900 block">{label}</span>
              {hint && <span className="text-xs font-arabic text-ink-400">{hint}</span>}
            </div>
            <button
              dir="ltr"
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={label}
              data-testid={`report-opt-${key}`}
              onClick={() => set(key, !on)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? "bg-saffron-600" : "bg-ink-300"}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => setPref("reportOptions", DEFAULT_REPORT_OPTIONS)}
        className="text-xs font-arabic text-saffron-700 underline"
      >
        إعادة الاختيار الافتراضي
      </button>
    </div>
  );
}
