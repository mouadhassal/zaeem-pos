import { useEffect, useState, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useCurrency } from "../../hooks/useCurrency";
import { z } from "zod";
import { useAuthStore } from "../../stores/authStore";
import { IconCash, IconPencil, IconTrash, IconX } from "@tabler/icons-react";
import { exportHtmlToPdf, pdfTableHtml } from "../../lib/pdfExport";

interface DebtorRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  total_debt_cents: number;
  total_paid_cents: number;
  balance_cents: number;
  last_transaction_at: string | null;
  is_active: number;
}

interface DebtEntryRow {
  id: string;
  debtor_id: string;
  order_id: string | null;
  amount_cents: number;
  entry_type: "DEBT" | "PAYMENT";
  notes: string | null;
  created_by: string;
  created_at: string;
}

interface DebtorDetail {
  debtor: DebtorRow;
  entries: DebtEntryRow[];
}

const debtorSchema = z.object({
  name: z.string().min(1, "الاسم مطلوب").max(100),
  phone: z.string().min(1, "رقم الهاتف مطلوب"),
  email: z.string().email("بريد غير صالح").optional().or(z.literal("")),
  address: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  initialDebt: z.string().optional().default(""),
});

type DebtorForm = z.infer<typeof debtorSchema>;

const emptyForm: DebtorForm = { name: "", phone: "", email: "", address: "", notes: "", initialDebt: "" };

function fmtDateTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ar-SA", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Debt aging: only meaningful for a debtor who still owes something and has
// a transaction on record to measure "since when" from -- a zero balance or
// a debtor who never had a transaction has nothing to age.
function agingDays(debtor: DebtorRow): number | null {
  if (debtor.balance_cents <= 0 || !debtor.last_transaction_at) return null;
  const ms = Date.now() - new Date(debtor.last_transaction_at).getTime();
  return Math.floor(ms / 86_400_000);
}

function AgingBadge({ debtor }: { debtor: DebtorRow }) {
  const days = agingDays(debtor);
  if (days === null) return <span className="text-ink-400 text-xs">-</span>;
  const tier =
    days >= 90 ? { label: `متأخر جدًا (${days} يوم)`, className: "bg-red-100 text-red-700" }
    : days >= 60 ? { label: `متأخر (${days} يوم)`, className: "bg-orange-100 text-orange-700" }
    : days >= 30 ? { label: `متأخر (${days} يوم)`, className: "bg-amber-100 text-amber-700" }
    : { label: `${days} يوم`, className: "bg-ink-100 text-ink-500" };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${tier.className}`}>{tier.label}</span>;
}

export default function DebtPage() {
  const { fmt } = useCurrency();
  const token = useAuthStore((s) => s.token);
  const [debtors, setDebtors] = useState<DebtorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<DebtorForm>(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [detail, setDetail] = useState<DebtorDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const [payModal, setPayModal] = useState<DebtorRow | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payNotes, setPayNotes] = useState("");

  const [exportingPdf, setExportingPdf] = useState(false);

  const filtered = debtors
    .filter((d) => {
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || d.phone.includes(q);
    })
    // Most-overdue first (agingDays is null for a zero balance -- sorted
    // last, they aren't a collections concern).
    .sort((a, b) => (agingDays(b) ?? -1) - (agingDays(a) ?? -1));

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await invoke<DebtorRow[]>("list_debtors_v3", { sessionToken: token });
      setDebtors(rows);
    } catch (err) {
      setError(`حدث خطأ في تحميل الديون: ${realErrorText(err)}`);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const openAdd = () => { setEditId(null); setForm(emptyForm); setFormErrors({}); setShowModal(true); };

  const openEdit = (d: DebtorRow) => {
    setEditId(d.id);
    setForm({ name: d.name, phone: d.phone, email: d.email ?? "", address: d.address ?? "", notes: d.notes ?? "", initialDebt: "" });
    setFormErrors({});
    setShowModal(true);
  };

  const save = async () => {
    const parsed = debtorSchema.safeParse(form);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) { const f = issue.path[0] as string; errs[f] = issue.message; }
      setFormErrors(errs);
      return;
    }
    setSaving(true);
    try {
      const args = {
        sessionToken: token,
        name: parsed.data.name, phone: parsed.data.phone,
        email: parsed.data.email || null, address: parsed.data.address || null, notes: parsed.data.notes || null,
      };
      if (editId) {
        await invoke("update_debtor_v3", { ...args, debtorId: editId });
      } else {
        const initialDebtCents = Math.round(parseFloat(parsed.data.initialDebt || "0") * 100) || null;
        await invoke("create_debtor_v3", { ...args, initialDebtCents });
      }
      setShowModal(false);
      await fetchAll();
    } catch (err) {
      setFormErrors({ _form: `حدث خطأ في الحفظ: ${realErrorText(err)}` });
    } finally { setSaving(false); }
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    try {
      await invoke("deactivate_debtor_v3", { sessionToken: token, debtorId: deleteId });
      setDeleteId(null);
      await fetchAll();
    } catch { setError("حدث خطأ في الحذف"); }
  };

  const openDetail = async (debtor: DebtorRow) => {
    try {
      const entries = await invoke<DebtEntryRow[]>("list_debt_entries_v3", { sessionToken: token, debtorId: debtor.id });
      setDetail({ debtor, entries });
      setDetailOpen(true);
    } catch (err) { setError(`حدث خطأ في تحميل التفاصيل: ${realErrorText(err)}`); }
  };

  const handlePay = async () => {
    if (!payModal) return;
    const cents = Math.round(parseFloat(payAmount || "0") * 100);
    if (cents <= 0) return;
    try {
      await invoke("record_debt_payment_v3", { sessionToken: token, debtorId: payModal.id, amountCents: cents, notes: payNotes || null });
      setPayModal(null);
      setPayAmount("");
      setPayNotes("");
      await fetchAll();
      if (detail && detail.debtor.id === payModal.id) {
        openDetail(payModal);
      }
    } catch (err) { setError(`حدث خطأ في تسجيل الدفعة: ${realErrorText(err)}`); }
  };

  const exportPdf = async () => {
    if (exportingPdf) return;
    setExportingPdf(true);
    try {
      const bodyHtml = `
        <h1 style="font-size:22px;font-weight:700;text-align:center;margin:0 0 4px">إدارة الديون</h1>
        <p style="font-size:11px;color:#667085;text-align:center;margin:0 0 16px">${new Date().toLocaleDateString("ar-SA")}</p>
        ${pdfTableHtml(
          "المدينون",
          ["الاسم", "الهاتف", "إجمالي الديون", "المدفوع", "المتبقي", "آخر معاملة"],
          debtors.map((d) => [
            d.name,
            d.phone,
            fmt(d.total_debt_cents),
            fmt(d.total_paid_cents),
            fmt(d.balance_cents),
            fmtDateTime(d.last_transaction_at),
          ])
        )}
      `;
      await exportHtmlToPdf(`الديون-${new Date().toISOString().slice(0, 10)}.pdf`, bodyHtml, token ?? "");
    } finally {
      setExportingPdf(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-ink-500 font-arabic">جاري التحميل...</div>;
  }

  if (error) {
    return <div className="flex items-center justify-center h-full text-red-500 font-arabic">{error}</div>;
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">إدارة الديون</h1>
        <div className="flex gap-2">
          <button onClick={openAdd} className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors">+ إضافة مدين</button>
          <button onClick={exportPdf} disabled={exportingPdf} className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50">
            {exportingPdf ? "جاري التصدير..." : "تصدير PDF"}
          </button>
        </div>
      </div>

      <input
        type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="ابحث بالاسم أو الهاتف..."
        className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
      />

      <div className="bg-white rounded-2xl shadow-sh-1 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-ink-400 font-arabic">
              <th className="text-right p-3 font-medium">الاسم</th>
              <th className="text-right p-3 font-medium">الهاتف</th>
              <th className="text-center p-3 font-medium">إجمالي الديون</th>
              <th className="text-center p-3 font-medium">المدفوع</th>
              <th className="text-center p-3 font-medium">المتبقي</th>
              <th className="text-center p-3 font-medium">التقادم</th>
              <th className="text-right p-3 font-medium">آخر معاملة</th>
              <th className="text-center p-3 font-medium">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => (
              <tr key={d.id} className="border-b border-ink-200 hover:bg-white cursor-pointer" onClick={() => openDetail(d)}>
                <td className="p-3 font-arabic text-ink-900 font-medium">{d.name}</td>
                <td className="p-3 font-mono text-ink-500" dir="ltr">{d.phone}</td>
                <td className="p-3 text-center font-mono text-red-500 font-bold">{fmt(d.total_debt_cents)}</td>
                <td className="p-3 text-center font-mono text-saffron-600 font-bold">{fmt(d.total_paid_cents)}</td>
                <td className={`p-3 text-center font-mono font-bold ${d.balance_cents > 0 ? "text-red-600" : "text-green-600"}`}>{fmt(d.balance_cents)}</td>
                <td className="p-3 text-center"><AgingBadge debtor={d} /></td>
                <td className="p-3 font-arabic text-ink-400 text-xs">{fmtDateTime(d.last_transaction_at)}</td>
                <td className="p-3 text-center" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-center gap-1">
                    <button onClick={() => { setPayModal(d); setPayAmount(""); setPayNotes(""); }} className="p-1.5 rounded-lg text-xs text-saffron-600 hover:bg-saffron-50 transition-colors" title="تسديد"><IconCash className="w-4 h-4" /></button>
                    <button onClick={() => openEdit(d)} className="p-1.5 rounded-lg text-xs text-amber-600 hover:bg-amber-50 transition-colors" title="تعديل"><IconPencil className="w-4 h-4" /></button>
                    <button onClick={() => setDeleteId(d.id)} className="p-1.5 rounded-lg text-xs text-red-500 hover:bg-red-50 transition-colors" title="حذف"><IconTrash className="w-4 h-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-ink-500 font-arabic">{searchQuery ? "لا توجد نتائج" : "لا يوجد مدينون"}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">{editId ? "تعديل مدين" : "إضافة مدين"}</h2>
            <div className="space-y-3">
              {(["name", "phone", "email", "address", "notes"] as (keyof DebtorForm)[]).map((field) => (
                <div key={field}>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">
                    {field === "name" ? "الاسم *" : field === "phone" ? "رقم الهاتف *" : field === "email" ? "البريد الإلكتروني" : field === "address" ? "العنوان" : "ملاحظات"}
                  </label>
                  {field === "notes" ? (
                    <textarea value={form[field]} onChange={(e) => setForm((p) => ({ ...p, [field]: e.target.value }))} rows={3} className="w-full px-4 py-2 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500 resize-none" />
                  ) : (
                    <input
                      type={field === "email" ? "email" : "text"}
                      value={form[field]} onChange={(e) => setForm((p) => ({ ...p, [field]: e.target.value }))}
                      className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                      dir={field === "phone" ? "ltr" : "rtl"}
                    />
                  )}
                  {formErrors[field] && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors[field]}</p>}
                </div>
              ))}
              {!editId && (
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">المبلغ الذي يدين به (اختياري)</label>
                  <input
                    type="number" min="0" step="0.01"
                    value={form.initialDebt}
                    onChange={(e) => setForm((p) => ({ ...p, initialDebt: e.target.value }))}
                    placeholder="0.00"
                    className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500"
                    dir="ltr"
                  />
                </div>
              )}
              {formErrors._form && <p className="text-sm text-red-500 font-arabic">{formErrors._form}</p>}
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowModal(false)} className="h-10 px-6 rounded-xl bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors">إلغاء</button>
              <button onClick={save} disabled={saving} className="h-10 px-6 rounded-xl bg-saffron-600 text-white font-arabic text-sm hover:bg-saffron-700 transition-colors disabled:opacity-50">{saving ? "جاري الحفظ..." : "حفظ"}</button>
            </div>
          </div>
        </div>
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">تأكيد الحذف</h2>
            <p className="text-sm font-arabic text-ink-500">هل أنت متأكد من حذف هذا المدين؟</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setDeleteId(null)} className="h-10 px-6 rounded-xl bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors">إلغاء</button>
              <button onClick={confirmDelete} className="h-10 px-6 rounded-xl bg-red-500 text-white font-arabic text-sm hover:bg-red-600 transition-colors">حذف</button>
            </div>
          </div>
        </div>
      )}

      {payModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">تسديد دفعة</h2>
            <p className="text-sm font-arabic text-ink-500">المدين: <span className="font-bold">{payModal.name}</span></p>
            <p className="text-sm font-arabic text-ink-400">المتبقي: <span className="font-mono font-bold text-red-600">{fmt(payModal.balance_cents)}</span></p>
            <input type="number" min="0" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="المبلغ" className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500" dir="ltr" />
            <input type="text" value={payNotes} onChange={(e) => setPayNotes(e.target.value)} placeholder="ملاحظات (اختياري)" className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500" />
            <div className="flex gap-2 pt-2">
              <button onClick={handlePay} disabled={!payAmount || parseFloat(payAmount) <= 0} className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-40">تسديد</button>
              <button onClick={() => setPayModal(null)} className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {detailOpen && detail && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="bg-black/30 flex-1" onClick={() => setDetailOpen(false)} />
          <div className="w-full max-w-lg bg-white shadow-2xl h-full overflow-y-auto animate-slide-in-left">
            <div className="p-6 space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold font-arabic text-ink-900">{detail.debtor.name}</h2>
                <button onClick={() => setDetailOpen(false)} className="p-2 rounded-lg text-ink-500 hover:bg-white transition-colors"><IconX className="w-4 h-4" /></button>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="bg-red-50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-red-600 font-mono">{fmt(detail.debtor.total_debt_cents)}</p>
                  <p className="text-xs text-red-700 font-arabic mt-1">إجمالي الديون</p>
                </div>
                <div className="bg-saffron-50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-saffron-600 font-mono">{fmt(detail.debtor.total_paid_cents)}</p>
                  <p className="text-xs text-saffron-600 font-arabic mt-1">المدفوع</p>
                </div>
                <div className={`rounded-xl p-3 text-center ${detail.debtor.balance_cents > 0 ? "bg-red-50" : "bg-saffron-50"}`}>
                  <p className={`text-2xl font-bold font-mono ${detail.debtor.balance_cents > 0 ? "text-red-600" : "text-saffron-600"}`}>{fmt(detail.debtor.balance_cents)}</p>
                  <p className="text-xs font-arabic mt-1">المتبقي</p>
                </div>
              </div>

              <div className="bg-white rounded-2xl p-4 space-y-2 shadow-sh-1">
                <h3 className="font-bold font-arabic text-sm text-ink-900">سجل المعاملات</h3>
                {detail.entries.length > 0 ? (
                  <div className="space-y-1">
                    {detail.entries.map((e) => (
                      <div key={e.id} className="flex justify-between items-center text-xs py-1.5 border-b border-ink-200 last:border-0">
                        <div className="flex items-center gap-2">
                          <span className={`inline-block w-2 h-2 rounded-full ${e.entry_type === "DEBT" ? "bg-red-400" : "bg-saffron-400"}`} />
                          <span className="font-arabic text-ink-400">{e.entry_type === "DEBT" ? "دين" : "دفعة"}</span>
                          <span className="font-arabic text-ink-500">{fmtDateTime(e.created_at)}</span>
                        </div>
                        <span className={`font-mono font-bold ${e.entry_type === "DEBT" ? "text-red-500" : "text-saffron-600"}`}>
                          {e.entry_type === "DEBT" ? "+" : "-"}{fmt(e.amount_cents)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-ink-500 font-arabic">لا توجد معاملات</p>
                )}
              </div>

              <div className="bg-white rounded-2xl p-4 space-y-2">
                <h3 className="font-bold font-arabic text-sm text-ink-900">معلومات الاتصال</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-ink-400 font-arabic">الهاتف</span><span className="font-mono text-ink-900" dir="ltr">{detail.debtor.phone}</span></div>
                  <div className="flex justify-between"><span className="text-ink-400 font-arabic">البريد</span><span className="text-ink-900">{detail.debtor.email || "-"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-400 font-arabic">العنوان</span><span className="text-ink-900">{detail.debtor.address || "-"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-400 font-arabic">ملاحظات</span><span className="text-ink-900">{detail.debtor.notes || "-"}</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideInLeft { from { transform: translateX(100%); } to { transform: translateX(0); } }
        .animate-slide-in-left { animation: slideInLeft 0.2s ease-out; }
      `}</style>
    </div>
  );
}
