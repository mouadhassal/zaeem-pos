import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPencil as Pencil, IconTrash as Trash } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { realErrorText } from "../../lib/errors";
import {
  DEFAULT_BILL_FOOTER, DEFAULT_TEMPLATE_CONFIG, kitchenTicketRows, parseTemplateConfig, receiptRows,
  type Row, type TemplateConfig, type TemplateFontSize,
} from "../../lib/ticketLayout";
import { SAMPLE_NOW, SAMPLE_RECEIPTS, SAMPLE_TICKETS } from "../../lib/ticketLayout.samples";

export interface ReceiptTemplate {
  id: string;
  name: string;
  kind: "BILL" | "KITCHEN";
  config: unknown;
}

const FONT_LABELS: Record<TemplateFontSize, string> = { small: "صغير", normal: "عادي", large: "كبير" };

/** The preview rows of a template on a sample bill or kitchen slip. */
export function previewRows(kind: "BILL" | "KITCHEN", config: TemplateConfig): Row[] {
  return kind === "BILL"
    ? receiptRows(SAMPLE_RECEIPTS[0]!, SAMPLE_NOW, config)
    : kitchenTicketRows(SAMPLE_TICKETS[0]!, SAMPLE_NOW, config);
}

/** The rows drawn as text on a paper-coloured strip, scaled like the printer scales them. */
export function TemplatePreview({ rows }: { rows: readonly Row[] }) {
  const px = (size?: number) => Math.max(8, Math.round((size ?? 26) * 0.5));
  return (
    <div dir="rtl" className="bg-white border border-ink-300 rounded-sm p-3 w-[300px] max-w-full font-arabic text-ink-900 shadow-inner" data-testid="template-preview">
      {rows.map((r, i) => {
        if (r.t === "line") {
          return <div key={i} style={{ textAlign: r.align ?? "right", fontSize: px(r.size), fontWeight: r.bold ? 700 : 400, lineHeight: 1.5 }}>{r.text}</div>;
        }
        if (r.t === "two") {
          return (
            <div key={i} className="flex justify-between gap-2" style={{ fontSize: px(r.size), fontWeight: r.bold ? 700 : 400, lineHeight: 1.5 }}>
              <span>{r.right}</span><span dir="ltr">{r.left}</span>
            </div>
          );
        }
        if (r.t === "rule") return <hr key={i} className="my-1 border-0 border-t border-ink-400" style={{ borderTopStyle: r.dashed ? "dashed" : "solid" }} />;
        return <div key={i} style={{ height: Math.round(r.h / 3) }} />;
      })}
    </div>
  );
}

interface Draft {
  id: string | null;
  name: string;
  kind: "BILL" | "KITCHEN";
  header: string;
  footer: string;
  config: TemplateConfig;
}

const toDraft = (t: ReceiptTemplate): Draft => {
  const config = parseTemplateConfig(t.config);
  return {
    id: t.id, name: t.name, kind: t.kind, config,
    header: config.header_lines.join("\n"),
    footer: (config.footer_lines ?? (t.kind === "BILL" ? DEFAULT_BILL_FOOTER : [])).join("\n"),
  };
};

const newDraft = (kind: "BILL" | "KITCHEN"): Draft => ({
  id: null, name: "", kind, config: { ...DEFAULT_TEMPLATE_CONFIG }, header: "",
  footer: kind === "BILL" ? DEFAULT_BILL_FOOTER.join("\n") : "",
});

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");

/** What the draft would be saved as. */
export function draftConfig(d: Draft): TemplateConfig {
  return { ...d.config, header_lines: lines(d.header), footer_lines: lines(d.footer) };
}

/** Settings > printers > "القوالب": how a printer's bill or kitchen slip looks, with a live preview. */
export default function TemplatesSection({ onChanged }: { onChanged?: () => void }) {
  const token = useAuthStore((s) => s.token);
  const [templates, setTemplates] = useState<ReceiptTemplate[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setTemplates(await invoke<ReceiptTemplate[]>("list_receipt_templates_v3", { sessionToken: token }));
    } catch (e) {
      setError(realErrorText(e));
    }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const preview = useMemo(() => (draft ? previewRows(draft.kind, draftConfig(draft)) : []), [draft]);

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) { setError("اكتب اسم القالب"); return; }
    setSaving(true);
    setError(null);
    try {
      await invoke("save_receipt_template_v3", { sessionToken: token, template: { id: draft.id, name: draft.name.trim(), kind: draft.kind, config: draftConfig(draft) } });
      setDraft(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(realErrorText(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (t: ReceiptTemplate) => {
    if (!window.confirm(`حذف القالب «${t.name}»؟ الطابعات التي تستخدمه تعود للشكل المعتاد.`)) return;
    try {
      await invoke("delete_receipt_template_v3", { sessionToken: token, templateId: t.id });
      await load();
      onChanged?.();
    } catch (e) {
      setError(realErrorText(e));
    }
  };

  const set = (patch: Partial<TemplateConfig>) => draft && setDraft({ ...draft, config: { ...draft.config, ...patch } });
  const field = "px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600";
  const switches: { key: keyof TemplateConfig; label: string; only?: "BILL" }[] = [
    { key: "show_order_number", label: "رقم الطلب" },
    { key: "show_table", label: "الطاولة" },
    { key: "show_cashier", label: "اسم الكاشير" },
    { key: "show_customer", label: "بيانات الزبون (الاسم والهاتف والعنوان)" },
    { key: "show_tax_line", label: "سطر الضريبة", only: "BILL" },
    { key: "show_item_notes", label: "ملاحظات الأصناف" },
  ];

  return (
    <div className="space-y-3" data-testid="templates-section">
      <div className="flex items-center justify-between">
        <h3 className="font-arabic font-bold text-ink-900">القوالب</h3>
        <div className="flex gap-2">
          <button onClick={() => setDraft(newDraft("BILL"))} className="h-9 px-4 rounded-sm bg-saffron-600 text-white text-xs font-bold font-arabic" data-testid="template-add-bill">+ قالب فاتورة</button>
          <button onClick={() => setDraft(newDraft("KITCHEN"))} className="h-9 px-4 rounded-sm bg-ink-800 text-white text-xs font-bold font-arabic" data-testid="template-add-kitchen">+ قالب مطبخ</button>
        </div>
      </div>
      <p className="text-xs text-ink-400 font-arabic">
        القالب يغيّر شكل ما تطبعه طابعة معيّنة (الفاتورة أو تذكرة المطبخ). الطابعة التي لا قالب لها تطبع كما هي. اختر القالب من بطاقة الطابعة أدناه.
        تقسيم المطبخ حسب الأقسام يبقى كما هو: كل طابعة مطبخ تأخذ أقسامها وشكل تذكرتها من قالبها.
      </p>
      {error && <p className="text-xs text-danger font-arabic">{error}</p>}

      {templates.length === 0 && !draft && <div className="bg-white rounded-md p-5 border border-ink-200 text-center text-ink-500 font-arabic text-sm">لا توجد قوالب بعد</div>}
      {templates.map((t) => (
        <div key={t.id} className="flex items-center justify-between gap-2 bg-white rounded-md p-3 border border-ink-200" data-testid="template-row">
          <span className="font-arabic text-sm text-ink-900">{t.name} <span className="text-xs text-ink-400">({t.kind === "BILL" ? "فاتورة" : "مطبخ"})</span></span>
          <div className="flex gap-1">
            <button onClick={() => { setError(null); setDraft(toDraft(t)); }} className="h-8 w-8 rounded-sm flex items-center justify-center text-ink-500 hover:bg-ink-100" title="تعديل"><Pencil className="w-3.5 h-3.5" /></button>
            <button onClick={() => void remove(t)} className="h-8 w-8 rounded-sm flex items-center justify-center text-ink-500 hover:bg-danger-soft hover:text-danger" title="حذف"><Trash className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      ))}

      {draft && (
        <div className="bg-white rounded-md p-5 border-2 border-saffron-600 grid gap-5 md:grid-cols-[1fr_auto]" data-testid="template-form">
          <div className="space-y-3">
            <p className="font-arabic text-sm font-bold text-ink-900">{draft.id ? "تعديل" : "قالب جديد"}: {draft.kind === "BILL" ? "فاتورة" : "تذكرة مطبخ"}</p>
            <label className="block space-y-1"><span className="text-xs text-ink-500 font-arabic">اسم القالب</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${field} w-full h-10`} data-testid="template-name" /></label>
            <label className="block space-y-1"><span className="text-xs text-ink-500 font-arabic">أسطر الرأس (سطر في كل سطر، حتى 8)</span>
              <textarea value={draft.header} onChange={(e) => setDraft({ ...draft, header: e.target.value })} rows={2} className={`${field} w-full py-2`} data-testid="template-header" /></label>
            <label className="block space-y-1"><span className="text-xs text-ink-500 font-arabic">أسطر الذيل {draft.kind === "BILL" ? "(اتركها فارغة بلا ذيل)" : ""}</span>
              <textarea value={draft.footer} onChange={(e) => setDraft({ ...draft, footer: e.target.value })} rows={2} className={`${field} w-full py-2`} data-testid="template-footer" /></label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {switches.filter((s) => !s.only || s.only === draft.kind).map((s) => (
                <label key={s.key} className="flex items-center gap-2 font-arabic text-sm text-ink-700">
                  <input type="checkbox" checked={draft.config[s.key] as boolean} onChange={(e) => set({ [s.key]: e.target.checked } as Partial<TemplateConfig>)} data-testid={`template-${s.key}`} />
                  {s.label}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-4 items-center">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-ink-500 font-arabic">حجم الخط:</span>
                {(["small", "normal", "large"] as TemplateFontSize[]).map((f) => (
                  <button key={f} onClick={() => set({ font_size: f })} data-testid={`template-font-${f}`}
                    className={`h-8 px-3 rounded-sm text-xs font-arabic ${draft.config.font_size === f ? "bg-saffron-600 text-white" : "bg-ink-100 text-ink-600"}`}>{FONT_LABELS[f]}</button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-ink-500 font-arabic">عدد النسخ:</span>
                {[1, 2, 3].map((n) => (
                  <button key={n} onClick={() => set({ copies: n })} data-testid={`template-copies-${n}`}
                    className={`h-8 w-8 rounded-sm text-xs font-mono ${draft.config.copies === n ? "bg-saffron-600 text-white" : "bg-ink-100 text-ink-600"}`}>{n}</button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <button onClick={() => { setDraft(null); setError(null); }} className="h-10 px-5 rounded-sm bg-ink-100 text-ink-700 font-arabic font-bold">إلغاء</button>
              <button onClick={() => void save()} disabled={saving} className="h-10 px-6 rounded-sm bg-saffron-600 text-white font-arabic font-bold disabled:opacity-50" data-testid="template-save">حفظ</button>
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-ink-500 font-arabic">معاينة مباشرة</p>
            <TemplatePreview rows={preview} />
          </div>
        </div>
      )}
    </div>
  );
}

/** A printer card's "القالب" choice: only the templates that fit the printer (bill / kitchen). */
export function PrinterTemplatePicker({ printer, onChanged }: { printer: { id: string; printer_type: string; template_id?: string | null }; onChanged: () => void | Promise<void> }) {
  const token = useAuthStore((s) => s.token);
  const [templates, setTemplates] = useState<ReceiptTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const kind = printer.printer_type === "KITCHEN" ? "KITCHEN" : printer.printer_type === "RECEIPT" ? "BILL" : null;

  useEffect(() => {
    if (!kind) return;
    invoke<ReceiptTemplate[]>("list_receipt_templates_v3", { sessionToken: token }).then(setTemplates).catch(() => setTemplates([]));
  }, [token, kind, printer.template_id]);

  if (!kind) return null;
  const fitting = templates.filter((t) => t.kind === kind);
  if (fitting.length === 0 && !printer.template_id) return null;

  const choose = async (templateId: string) => {
    setError(null);
    try {
      await invoke("set_printer_template_v3", { sessionToken: token, printerId: printer.id, templateId: templateId === "" ? null : templateId });
      await onChanged();
    } catch (e) {
      setError(realErrorText(e));
    }
  };

  return (
    <div className="flex items-center gap-3" data-testid="printer-template-picker">
      <span className="text-sm text-ink-400 font-arabic shrink-0">القالب:</span>
      <select
        value={printer.template_id ?? ""}
        onChange={(e) => void choose(e.target.value)}
        className="flex-1 h-9 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-xs outline-none focus:border-saffron-600"
      >
        <option value="">الشكل المعتاد</option>
        {fitting.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      {error && <span className="text-xs text-danger font-arabic">{error}</span>}
    </div>
  );
}
