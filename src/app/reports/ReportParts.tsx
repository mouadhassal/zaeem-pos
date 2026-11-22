import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { realErrorText } from "../../lib/errors";
import { exportHtmlToPdf, pdfTableHtml } from "../../lib/pdfExport";
import { exportTablesToExcel, pdfRows, type ReportTable } from "../../lib/exportExcel";
import { toLocalDateStr } from "../../lib/dateLocal";
import { changeText, changeTone, type Change } from "../../lib/reportMath";

/** The period every report tab shows: ISO instants and the till's offset from UTC in minutes. */
export interface ReportRange {
  startIso: string;
  endIso: string;
  tz: number;
}

/** Loads one report command for the period. `args` are the extra arguments; the data reloads when they or the range change. */
export function useReport<T>(command: string, range: ReportRange, args: Record<string, unknown> = {}, enabled = true) {
  const token = useAuthStore((s) => s.token);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const argsKey = JSON.stringify(args);
  const stable = useMemo(() => JSON.parse(argsKey) as Record<string, unknown>, [argsKey]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    invoke<T>(command, { sessionToken: token, startIso: range.startIso, endIso: range.endIso, tzOffsetMinutes: range.tz, ...stable })
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(realErrorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [command, token, range.startIso, range.endIso, range.tz, stable, enabled]);

  return { data, error, loading };
}

export function Card({ title, hint, actions, children, testId }: { title: string; hint?: string; actions?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="zc-card p-4 space-y-3" data-testid={testId}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="font-bold text-ink-900 font-arabic">{title}</h2>
          {hint && <p className="text-xs text-ink-400 font-arabic mt-0.5">{hint}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/** A one-line "nothing to show" / error / loading note. */
export function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return <p className={`text-sm font-arabic ${tone === "error" ? "text-danger" : "text-ink-400"}`}>{children}</p>;
}

/** The "▲ 12%" chip: green when the change is good, red when bad (cancellations and discounts: up is bad). */
export function ChangeBadge({ change, higherIsBetter = true }: { change: Change; higherIsBetter?: boolean }) {
  const tone = changeTone(change, higherIsBetter);
  const cls = tone === "good" ? "text-ok bg-ok-soft" : tone === "bad" ? "text-danger bg-danger-soft" : "text-ink-400 bg-surface-alt";
  return <span className={`inline-block px-1.5 py-0.5 rounded-sm text-xs font-bold font-arabic whitespace-nowrap ${cls}`} data-testid="change-badge">{changeText(change)}</span>;
}

/** A row's share of the total as a number with a thin bar. */
export function ShareBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2 min-w-[96px]">
      <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden">
        <div className="h-full bg-saffron-500" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
      <span className="text-xs text-ink-500 tabular w-12 text-end">{pct}%</span>
    </div>
  );
}

export function Th({ children, end = false }: { children?: ReactNode; end?: boolean }) {
  return <th className={`p-2 whitespace-nowrap font-bold ${end ? "text-end" : "text-start"}`}>{children}</th>;
}

export const TABLE = "w-full text-sm font-arabic";
export const THEAD = "text-ink-500 border-b border-ink-200";

/** PDF and Excel buttons for one table: the same rows in both. */
export function ExportButtons({ title, filename, headers, rows, moneyCols }: { title: string; filename: string; headers: string[]; rows: (string | number | null)[][]; moneyCols?: number[] }) {
  const token = useAuthStore((s) => s.token);
  const [busy, setBusy] = useState<"pdf" | "xlsx" | null>(null);
  const stamp = toLocalDateStr(new Date());
  const table: ReportTable = { title, headers, rows, ...(moneyCols ? { moneyCols } : {}) };

  const pdf = async () => {
    if (busy) return;
    setBusy("pdf");
    try {
      const body = `<h1 style="font-size:22px;font-weight:700;text-align:center;margin:0 0 4px">${title.replace(/</g, "&lt;")}</h1>${pdfTableHtml(title, headers, pdfRows(table))}`;
      await exportHtmlToPdf(`${filename}-${stamp}.pdf`, body, token ?? "");
    } finally {
      setBusy(null);
    }
  };
  const excel = async () => {
    if (busy) return;
    setBusy("xlsx");
    try {
      await exportTablesToExcel(`${filename}-${stamp}.xlsx`, [table], token ?? "");
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <button type="button" onClick={() => void pdf()} disabled={busy !== null || rows.length === 0} className="h-8 px-3 rounded-sm bg-danger-soft text-danger border border-danger-soft text-xs font-bold font-arabic disabled:opacity-50" data-testid="export-pdf">
        {busy === "pdf" ? "جاري التصدير..." : "تصدير PDF"}
      </button>
      <button type="button" onClick={() => void excel()} disabled={busy !== null || rows.length === 0} className="h-8 px-3 rounded-sm bg-ok-soft text-ok border border-ok-soft text-xs font-bold font-arabic disabled:opacity-50" data-testid="export-excel">
        {busy === "xlsx" ? "جاري التصدير..." : "Excel"}
      </button>
    </>
  );
}
