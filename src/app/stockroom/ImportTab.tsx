import { useMemo, useRef, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney, getCurrency, scaleFor } from "../../lib/money";
import { IMPORT_TEMPLATE, readImport } from "../../lib/shop";
import { Hint, btnGhost, btnPrimary } from "../payroll/ui";

interface Summary {
  created: number;
  updated: number;
  skipped: number;
  problems: { row: number; message: string }[];
}

/**
 * Bring a whole product list in from a spreadsheet: paste the cells copied from Excel, or choose a saved
 * .csv file. The page shows what it understood (columns, how many products, every bad line with its reason)
 * before anything is saved.
 */
export default function ImportTab({ onDone }: { onDone: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Summary | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => (text.trim() === "" ? null : readImport(text, scaleFor(getCurrency()))), [text]);

  const readFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(f, "utf-8");
  };

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(IMPORT_TEMPLATE);
      toast.success("نُسخ القالب. الصقه في Excel (Ctrl+V)");
    } catch {
      setText(IMPORT_TEMPLATE);
      toast.success("وُضع القالب في الحقل أدناه. انسخه إلى Excel");
    }
  };

  const run = async () => {
    if (!parsed || parsed.rows.length === 0) return;
    setBusy(true);
    try {
      const out = await invoke<Summary>("import_products_v3", { sessionToken: token, rows: parsed.rows });
      setResult(out);
      toast.success(`تم الاستيراد: ${out.created} جديد، ${out.updated} محدَّث`);
      if (out.skipped === 0 && parsed.problems.length === 0) onDone();
    } catch (err) {
      toast.error(realErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="import-tab">
      <Hint summary="جهّز قائمة منتجاتك في Excel بالأعمدة: اسم الصنف، الباركود، سعر البيع، التكلفة، الفئة، الكمية، الحد الأدنى، طريقة البيع.">
        <p>المطلوب فقط عمودا «اسم الصنف» و«سعر البيع». الباقي اختياري، والترتيب لا يهم، ويُفهم العنوان بالعربية أو الإنجليزية.</p>
        <p><b>الكمية</b> هي ما على الرف الآن. إن وضعتها يُفعَّل تتبع مخزون الصنف. <b>طريقة البيع</b>: «قطعة» أو «وزن» (للوزن السعر هو سعر الكيلوغرام والكمية بالكيلوغرام).</p>
        <p>يُطابَق الصنف بالباركود، فإن لم يوجد باركود بالاسم: الموجود يُحدَّث والجديد يُضاف. الفئات تُنشأ تلقائياً. أخطاء الأسطر تظهر قبل الحفظ، وتُستورَد الأسطر الصحيحة فقط.</p>
        <p>انتبه: Excel يحذف الأصفار من بداية الباركود إن حفظته كرقم. اجعل عمود الباركود من النوع «نص» قبل اللصق.</p>
      </Hint>
      <div className="flex flex-wrap gap-3">
        <button onClick={copyTemplate} className={btnGhost} data-testid="import-template">نسخ قالب Excel</button>
        <button onClick={() => file.current?.click()} className={btnGhost} data-testid="import-file-button">اختيار ملف CSV</button>
        <input ref={file} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} data-testid="import-file" />
      </div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setResult(null); }}
        placeholder="الصق هنا الخلايا المنسوخة من Excel (مع السطر الأول للعناوين)"
        rows={8}
        className="w-full rounded-sm border border-ink-200 p-3 font-mono text-xs outline-none focus:border-saffron-500"
        dir="ltr"
        data-testid="import-text"
      />

      {parsed && parsed.missingColumns.length > 0 && (
        <div className="rounded-md border border-danger bg-danger-soft p-3 text-sm font-arabic text-ink-900" data-testid="import-missing">
          لم أجد عمود: {parsed.missingColumns.join("، ")}. تأكد أن السطر الأول يحوي العناوين (مثل «اسم الصنف» و«سعر البيع»).
        </div>
      )}

      {parsed && parsed.missingColumns.length === 0 && (
        <div className="space-y-3" data-testid="import-preview">
          <p className="text-sm font-arabic text-ink-700">
            فهمتُ الأعمدة: {parsed.recognised.map((r) => `«${r.header}» ← ${r.as}`).join("، ")}
          </p>
          <p className="text-sm font-arabic font-bold text-ink-900" data-testid="import-count">{parsed.rows.length} صنف جاهز للاستيراد{parsed.problems.length > 0 ? `، و${parsed.problems.length} سطر فيه خطأ` : ""}</p>
          {parsed.rows.length > 0 && (
            <div className="zc-card overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic"><th className="text-right p-2">#</th><th className="text-right p-2">الاسم</th><th className="p-2">الباركود</th><th className="p-2">السعر</th><th className="p-2">التكلفة</th><th className="p-2">الفئة</th><th className="p-2">الكمية</th></tr></thead>
                <tbody>
                  {parsed.rows.slice(0, 8).map((r) => (
                    <tr key={r.row} className="border-b border-ink-100"><td className="p-2 font-mono">{r.row}</td><td className="p-2 font-arabic">{r.name}</td><td className="p-2 text-center font-mono" dir="ltr">{r.barcode ?? ""}</td><td className="p-2 text-center font-mono">{formatMoney(r.price_cents)}</td><td className="p-2 text-center font-mono">{r.cost_cents === null ? "" : formatMoney(r.cost_cents)}</td><td className="p-2 text-center font-arabic">{r.category ?? ""}</td><td className="p-2 text-center font-mono">{r.stock ?? ""}{r.sold_by === "weight" ? " كغ" : ""}</td></tr>
                  ))}
                </tbody>
              </table>
              {parsed.rows.length > 8 && <p className="p-2 text-[11px] text-ink-400 font-arabic">… و{parsed.rows.length - 8} صنف آخر</p>}
            </div>
          )}
          {parsed.problems.length > 0 && (
            <ul className="rounded-md border border-warn bg-warn-soft p-3 text-sm font-arabic space-y-1 max-h-48 overflow-y-auto" data-testid="import-problems">
              {parsed.problems.map((p) => <li key={p.row}>السطر {p.row}: {p.message}</li>)}
            </ul>
          )}
          <div className="flex justify-end">
            <button onClick={run} disabled={busy || parsed.rows.length === 0} className={btnPrimary} data-testid="import-run">{busy ? "جاري الاستيراد..." : `استيراد ${parsed.rows.length} صنف`}</button>
          </div>
        </div>
      )}

      {result && (
        <div className="rounded-md border border-ink-200 bg-white p-4 space-y-2 text-sm font-arabic" data-testid="import-result">
          <p className="font-bold text-ink-900">النتيجة: {result.created} جديد · {result.updated} محدَّث · {result.skipped} متخطّى</p>
          {result.problems.length > 0 && <ul className="space-y-1 text-warn-700">{result.problems.map((p) => <li key={p.row}>السطر {p.row}: {p.message}</li>)}</ul>}
          <button onClick={onDone} className={btnGhost}>عرض المخزون</button>
        </div>
      )}
    </div>
  );
}
