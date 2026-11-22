import { useState } from "react";
import { useAuthStore } from "../../stores/authStore";
import { exportTablesToExcel, type ReportTable } from "../../lib/exportExcel";
import { toLocalDateStr } from "../../lib/dateLocal";

/**
 * The "Excel" button that sits next to a PDF button: the same tables written as an .xlsx (right to left,
 * Arabic text), saved the way the PDF is. `tables` is read when the button is pressed, so it always
 * exports what is on screen at that moment.
 */
export default function ExcelButton({ filename, tables, className }: { filename: string; tables: () => ReportTable[]; className?: string }) {
  const token = useAuthStore((s) => s.token);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await exportTablesToExcel(`${filename}-${toLocalDateStr(new Date())}.xlsx`, tables(), token ?? "");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void go()}
      disabled={busy}
      data-testid="export-excel"
      className={className ?? "h-10 px-4 rounded-sm bg-ok-soft text-ok border border-ok-soft text-sm font-bold font-arabic hover:opacity-90 transition-opacity disabled:opacity-50"}
    >
      {busy ? "جاري التصدير..." : "Excel"}
    </button>
  );
}
