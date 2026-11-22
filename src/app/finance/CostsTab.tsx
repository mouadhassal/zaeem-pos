import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPaperclip, IconPencil, IconX } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { formatMoney, minorToInputValue, parseMoneyInput } from "../../lib/money";
import { realErrorText } from "../../lib/errors";
import { toLocalDateStr } from "../../lib/dateLocal";
import DatePicker from "../../components/ui/DatePicker";
import { ADVANCE_CATEGORY, categoryHint, EXPENSE_CATEGORIES } from "../../lib/profit";
import { COST_GROUPS, monthOf, monthRange, paymentMethodLabel, PAYMENT_METHODS, type CostGroupBy } from "../../lib/finance";

/** One expense as `list_operational_costs_v3` returns it (finance.rs `CostRow`). */
export interface CostRecord {
  id: string;
  category: string;
  category_label: string;
  amount_cents: number;
  notes: string | null;
  date: string;
  payment_date: string | null;
  payee: string | null;
  payment_method: string | null;
  reference_no: string | null;
  cost_centre: string | null;
  has_attachment: boolean;
  accrual_period: string | null;
  reference_type: string | null;
  reference_id: string | null;
}

interface CostGroup {
  key: string;
  label: string;
  total_cents: number;
  count: number;
}

interface CostReport {
  group_by: string;
  total_cents: number;
  count: number;
  groups: CostGroup[];
}

export interface FinanceSettings {
  cost_basis: "accrual" | "payment";
  custom_categories: string[];
  builtin_categories: string[];
}

type CostRange = "month" | "all" | "custom";

interface Props {
  token: string | null;
  /** Called with the rows on screen, so the PDF export can print them. */
  onRows: (rows: CostRecord[]) => void;
  notify: (message: string) => void;
}

const INPUT = "w-full h-10 px-4 rounded-sm bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500";
const BTN = "h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-40";

interface Form {
  category: string;
  amount: string;
  date: string;
  notes: string;
  payment_date: string;
  payee: string;
  payment_method: string;
  reference_no: string;
  cost_centre: string;
  accrual_period: string;
}

function emptyForm(category: string): Form {
  return { category, amount: "", date: toLocalDateStr(new Date()), notes: "", payment_date: "", payee: "", payment_method: "", reference_no: "", cost_centre: "", accrual_period: "" };
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

/** The التكاليف tab: quick entry, filters, totals by category / month / cost centre, receipts, settings. */
export default function CostsTab({ token, onRows, notify }: Props) {
  const [range, setRange] = useState<CostRange>("month");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [category, setCategory] = useState("");
  const [centre, setCentre] = useState("");
  const [groupBy, setGroupBy] = useState<CostGroupBy>("category");

  const [costs, setCosts] = useState<CostRecord[]>([]);
  const [report, setReport] = useState<CostReport | null>(null);
  const [centres, setCentres] = useState<string[]>([]);
  const [settings, setSettings] = useState<FinanceSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm(EXPENSE_CATEGORIES[0]));
  const [moreOpen, setMoreOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [existingReceipt, setExistingReceipt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // An advance to a worker («سلفة موظف»): who took it, and how much is taken off each salary.
  const [workers, setWorkers] = useState<{ user_id: string; name: string }[] | null>(null);
  const [workersError, setWorkersError] = useState<string | null>(null);
  const [advanceUser, setAdvanceUser] = useState("");
  const [advanceInstalment, setAdvanceInstalment] = useState("");

  const [receipt, setReceipt] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newCategory, setNewCategory] = useState("");

  const isAdvance = form.category === ADVANCE_CATEGORY && !editId;
  useEffect(() => {
    if (!isAdvance || workers) return;
    invoke<{ user_id: string; name: string; pay: unknown | null }[]>("list_payroll_employees_v3", { sessionToken: token })
      .then((rows) => {
        const list = rows.filter((r) => r.pay).map((r) => ({ user_id: r.user_id, name: r.name }));
        setWorkers(list);
        setAdvanceUser((u) => u || list[0]?.user_id || "");
      })
      .catch((err) => setWorkersError(realErrorText(err)));
  }, [isAdvance, workers, token]);

  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  const [from, to] = useMemo((): [string | undefined, string | undefined] => {
    if (range === "all") return [undefined, undefined];
    if (range === "custom") return [customStart || undefined, customEnd || undefined];
    return monthRange(monthOf(toLocalDateStr(new Date())));
  }, [range, customStart, customEnd]);

  const categories = useMemo(() => [...EXPENSE_CATEGORIES, ...(settings?.custom_categories ?? [])], [settings]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filter = { startDate: from ?? null, endDate: to ?? null, category: category || null, costCentre: centre || null };
      const [rows, rep] = await Promise.all([
        invoke<CostRecord[]>("list_operational_costs_v3", { sessionToken: token, ...filter }),
        invoke<CostReport>("get_cost_report_v3", { sessionToken: token, groupBy, ...filter }),
      ]);
      setCosts(rows);
      setReport(rep);
      onRows(rows);
      if (!centre) {
        setCentres(Array.from(new Set(rows.map((r) => r.cost_centre).filter((c): c is string => !!c))));
      }
    } catch (err) {
      notify(`حدث خطأ في تحميل التكاليف: ${realErrorText(err)}`);
    } finally {
      setLoading(false);
    }
    // onRows/notify are stable setters from the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, from, to, category, centre, groupBy]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    invoke<FinanceSettings>("get_finance_settings_v3", { sessionToken: token })
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [token]);

  const openNew = () => {
    setEditId(null);
    setForm(emptyForm(EXPENSE_CATEGORIES[0]));
    setAdvanceInstalment("");
    setMoreOpen(false);
    setFile(null);
    setExistingReceipt(null);
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (c: CostRecord) => {
    setEditId(c.id);
    setForm({
      category: c.category_label,
      amount: minorToInputValue(c.amount_cents),
      date: c.date.slice(0, 10),
      notes: c.notes ?? "",
      payment_date: c.payment_date ?? "",
      payee: c.payee ?? "",
      payment_method: c.payment_method ?? "",
      reference_no: c.reference_no ?? "",
      cost_centre: c.cost_centre ?? "",
      accrual_period: c.accrual_period ?? "",
    });
    setMoreOpen(!!(c.payment_date || c.payee || c.payment_method || c.reference_no || c.cost_centre || c.accrual_period || c.has_attachment));
    setFile(null);
    setExistingReceipt(null);
    setFormError(null);
    if (c.has_attachment) {
      invoke<string | null>("get_cost_attachment_v3", { sessionToken: token, costId: c.id }).then(setExistingReceipt).catch(() => setExistingReceipt(null));
    }
    setFormOpen(true);
  };

  const save = async () => {
    if (saving) return;
    const amount = parseMoneyInput(form.amount);
    if (amount <= 0) {
      setFormError("يرجى إدخال مبلغ صحيح");
      return;
    }
    if (file && file.size > 3 * 1024 * 1024) {
      setFormError("الصورة كبيرة جداً (الحد الأقصى 3 ميجابايت)");
      return;
    }
    if (isAdvance && !advanceUser) {
      setFormError("اختر الموظف الذي أخذ السلفة");
      return;
    }
    const instalment = parseMoneyInput(advanceInstalment);
    if (isAdvance && instalment > amount) {
      setFormError("القسط أكبر من مبلغ السلفة");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const args = {
        sessionToken: token,
        category: form.category,
        amountCents: amount,
        date: form.date,
        notes: orNull(form.notes),
        paymentDate: orNull(form.payment_date),
        payee: orNull(form.payee),
        paymentMethod: orNull(form.payment_method),
        referenceNo: orNull(form.reference_no),
        costCentre: orNull(form.cost_centre),
        accrualPeriod: orNull(form.accrual_period),
      };
      let id = editId;
      if (editId) {
        await invoke("update_operational_cost_v3", { ...args, costId: editId });
      } else {
        id = await invoke<string>("create_operational_cost_v3", isAdvance ? { ...args, advanceUserId: advanceUser, advanceInstalmentCents: instalment > 0 ? instalment : amount } : args);
      }
      if (file && id) {
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        try {
          await invoke("upload_cost_attachment_v3", { sessionToken: token, costId: id, photoBytes: bytes });
        } catch {
          notify("حُفظ المصروف لكن تعذر رفع الصورة — تأكد أنها JPEG أو PNG أو WEBP");
        }
      }
      setFormOpen(false);
      notify(editId ? "تم تعديل المصروف" : "تم إضافة التكلفة بنجاح");
      load();
    } catch (err) {
      setFormError(`حدث خطأ في الحفظ: ${realErrorText(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const showReceipt = async (id: string) => {
    try {
      const uri = await invoke<string | null>("get_cost_attachment_v3", { sessionToken: token, costId: id });
      if (uri) setReceipt(uri);
      else notify("الصورة غير موجودة على هذا الجهاز");
    } catch (err) {
      notify(`تعذر فتح الصورة: ${realErrorText(err)}`);
    }
  };

  const saveSettings = async (basis: "accrual" | "payment", custom: string[]) => {
    try {
      const next = await invoke<FinanceSettings>("save_finance_settings_v3", { sessionToken: token, costBasis: basis, customCategories: custom });
      setSettings(next);
      notify("تم حفظ الإعدادات");
    } catch (err) {
      notify(`تعذر الحفظ: ${realErrorText(err)}`);
    }
  };

  const addCustom = () => {
    const name = newCategory.trim();
    if (!name || !settings) return;
    setNewCategory("");
    saveSettings(settings.cost_basis, [...settings.custom_categories, name]);
  };

  const total = report?.total_cents ?? 0;

  return (
    <div className="space-y-4" data-testid="costs-tab">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="bg-white rounded-md p-4 border border-ink-200 flex-1 max-w-xs">
          <p className="text-ink-400 text-sm font-arabic">إجمالي التكاليف</p>
          <p className="text-2xl font-bold text-danger-600 font-mono">{formatMoney(total)}</p>
          <p className="text-[11px] text-ink-400 font-arabic">{report?.count ?? 0} مصروف</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setSettingsOpen((v) => !v)} className="h-10 px-4 rounded-sm border border-ink-200 text-ink-700 text-sm font-arabic hover:bg-white">
            إعدادات المصروفات
          </button>
          <button onClick={openNew} className={BTN}>+ إضافة تكلفة</button>
        </div>
      </div>

      {settingsOpen && settings && (
        <div className="zc-card p-4 space-y-4" data-testid="finance-settings">
          <div className="space-y-2">
            <p className="font-bold text-ink-900 font-arabic text-sm">متى يُحسب المصروف في الأرباح؟</p>
            {([
              ["accrual", "على شهر استحقاقه (الأفضل): إيجار أكتوبر المدفوع في نوفمبر يُحسب على أكتوبر."],
              ["payment", "على يوم الدفع: يُحسب المصروف يوم خرج المال."],
            ] as const).map(([value, text]) => (
              <label key={value} className="flex items-start gap-2 text-sm font-arabic text-ink-900 cursor-pointer">
                <input type="radio" name="cost-basis" checked={settings.cost_basis === value} onChange={() => saveSettings(value, settings.custom_categories)} className="mt-1" />
                <span>{text}</span>
              </label>
            ))}
          </div>
          <div className="space-y-2">
            <p className="font-bold text-ink-900 font-arabic text-sm">بنودي الخاصة</p>
            <div className="flex flex-wrap gap-2">
              {settings.custom_categories.map((c) => (
                <span key={c} className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-saffron-50 text-ink-900 text-xs font-arabic">
                  {c}
                  <button
                    onClick={() => saveSettings(settings.cost_basis, settings.custom_categories.filter((x) => x !== c))}
                    className="text-ink-400 hover:text-danger"
                    title="حذف من القائمة (المصروفات القديمة تبقى)"
                  >
                    <IconX className="w-3 h-3" />
                  </button>
                </span>
              ))}
              {settings.custom_categories.length === 0 && <span className="text-xs text-ink-400 font-arabic">لا بنود خاصة بعد</span>}
            </div>
            <div className="flex gap-2 max-w-md">
              <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addCustom()} placeholder="اسم بند جديد" maxLength={40} className={INPUT} />
              <button onClick={addCustom} disabled={!newCategory.trim()} className={BTN}>إضافة</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {([["month", "هذا الشهر"], ["all", "الكل"], ["custom", "مخصص"]] as const).map(([r, label]) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-4 py-2 rounded-lg font-arabic text-sm transition-colors ${range === r ? "bg-saffron-600 text-white" : "bg-white text-ink-500 hover:bg-ink-200"}`}
          >
            {label}
          </button>
        ))}
        {range === "custom" && (
          <>
            <DatePicker value={customStart} onChange={setCustomStart} className="h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
            <DatePicker value={customEnd} onChange={setCustomEnd} className="h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
          </>
        )}
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-10 px-3 rounded-sm bg-white border border-ink-200 text-sm font-arabic" aria-label="البند">
          <option value="">كل البنود</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={centre} onChange={(e) => setCentre(e.target.value)} className="h-10 px-3 rounded-sm bg-white border border-ink-200 text-sm font-arabic" aria-label="مركز التكلفة">
          <option value="">كل المراكز</option>
          <option value="-">بدون مركز</option>
          {centres.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="zc-card overflow-x-auto" data-testid="cost-report">
        <div className="p-4 pb-0 flex items-center justify-between gap-3 flex-wrap">
          <h2 className="font-bold text-ink-900 font-arabic">إجمالي المصروفات</h2>
          <div className="flex gap-1">
            {COST_GROUPS.map((g) => (
              <button
                key={g.value}
                onClick={() => setGroupBy(g.value)}
                className={`px-3 py-1 rounded-full text-xs font-arabic ${groupBy === g.value ? "bg-saffron-600 text-white" : "bg-white text-ink-500 hover:bg-ink-200"}`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full text-sm mt-2">
          <thead>
            <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
              <th className="text-right p-3 font-medium">{groupBy === "period" ? "الشهر" : groupBy === "cost_centre" ? "مركز التكلفة" : "البند"}</th>
              <th className="text-right p-3 font-medium">العدد</th>
              <th className="text-right p-3 font-medium">المجموع</th>
              <th className="text-right p-3 font-medium">النسبة</th>
            </tr>
          </thead>
          <tbody>
            {(report?.groups ?? []).map((g) => (
              <tr key={g.key} className="border-b border-ink-100">
                <td className="p-3 font-arabic text-ink-900">{g.label}</td>
                <td className="p-3 font-mono text-ink-500">{g.count}</td>
                <td className="p-3 font-mono text-danger-600 font-bold">{formatMoney(g.total_cents)}</td>
                <td className="p-3 font-mono text-ink-500">{total > 0 ? `${Math.round((g.total_cents * 100) / total)}%` : "-"}</td>
              </tr>
            ))}
            {(report?.groups.length ?? 0) === 0 && (
              <tr><td colSpan={4} className="p-4 text-center text-ink-500 font-arabic">لا توجد تكاليف في هذه الفترة</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="zc-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
              <th className="text-right p-3 font-medium">التاريخ</th>
              <th className="text-right p-3 font-medium">البند</th>
              <th className="text-right p-3 font-medium">المستفيد</th>
              <th className="text-right p-3 font-medium">مركز التكلفة</th>
              <th className="text-right p-3 font-medium">التكلفة</th>
              <th className="text-right p-3 font-medium">الملاحظات</th>
              <th className="text-center p-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {costs.map((c) => (
              <tr key={c.id} className="border-b border-ink-200 hover:bg-saffron-50">
                <td className="p-3 font-arabic text-ink-900">
                  {c.date.slice(0, 10)}
                  {c.accrual_period && c.accrual_period !== c.date.slice(0, 7) && <span className="block text-[11px] text-ink-400">عن شهر {c.accrual_period}</span>}
                </td>
                <td className="p-3">
                  <span className="inline-block px-3 py-1 rounded-full text-xs font-arabic bg-white text-ink-900">{c.category_label}</span>
                </td>
                <td className="p-3 text-ink-700 text-sm font-arabic">
                  {c.payee || "-"}
                  {c.payment_method && <span className="block text-[11px] text-ink-400">{paymentMethodLabel(c.payment_method)}{c.reference_no ? ` · ${c.reference_no}` : ""}</span>}
                </td>
                <td className="p-3 text-ink-700 text-sm font-arabic">{c.cost_centre || "-"}</td>
                <td className="p-3 font-mono text-danger-600 font-bold">{formatMoney(c.amount_cents)}</td>
                <td className="p-3 text-ink-400 text-sm">{c.notes || "-"}</td>
                <td className="p-3 text-center whitespace-nowrap">
                  {c.has_attachment && (
                    <button onClick={() => showReceipt(c.id)} className="px-2 py-1 rounded-lg text-ink-500 hover:bg-white" title="عرض الإيصال"><IconPaperclip className="w-4 h-4" /></button>
                  )}
                  {(!c.reference_type || c.reference_type === "rent") && (
                    <button onClick={() => openEdit(c)} className="px-2 py-1 rounded-lg text-ink-500 hover:bg-white" title="تعديل"><IconPencil className="w-4 h-4" /></button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && costs.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-ink-500 font-arabic">لا توجد تكاليف مسجلة</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-md shadow-xl w-full max-w-lg mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold font-arabic text-ink-900">{editId ? "تعديل تكلفة" : "إضافة تكلفة"}</h2>
              <button onClick={() => setFormOpen(false)} className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center text-ink-500 shrink-0"><IconX className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">البند</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={INPUT}>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  {!categories.includes(form.category) && <option value={form.category}>{form.category}</option>}
                </select>
                <p className="mt-1 text-[11px] text-ink-400 font-arabic" data-testid="cost-category-hint">{categoryHint(form.category)}</p>
              </div>
              {isAdvance && (
                <div className="grid grid-cols-2 gap-3 rounded-md border border-saffron-300 bg-saffron-50 p-3" data-testid="advance-fields">
                  <div>
                    <label className="block text-sm font-arabic text-ink-900 mb-1">الموظف</label>
                    <select value={advanceUser} onChange={(e) => setAdvanceUser(e.target.value)} className={INPUT} data-testid="advance-worker">
                      {(workers ?? []).map((w) => <option key={w.user_id} value={w.user_id}>{w.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-arabic text-ink-900 mb-1">القسط من كل راتب</label>
                    <input type="number" min="0" step="0.01" value={advanceInstalment} onChange={(e) => setAdvanceInstalment(e.target.value)} placeholder="كامل المبلغ" className={`${INPUT} font-mono`} dir="ltr" data-testid="advance-instalment" />
                  </div>
                  {workersError && <p className="col-span-2 text-xs text-danger font-arabic">{workersError}</p>}
                  {workers && workers.length === 0 && !workersError && <p className="col-span-2 text-xs text-warn font-arabic">لا موظفين لهم راتب محدد. حدّد الرواتب من صفحة «الرواتب» أولاً.</p>}
                  <p className="col-span-2 text-[11px] text-ink-500 font-arabic">تُسجَّل السلفة على الموظف في «الرواتب» تلقائياً وتُخصم أقساطها من رواتبه، ولا تسجّلها هناك مرة ثانية.</p>
                </div>
              )}
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">المبلغ</label>
                <input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={`${INPUT} font-mono`} dir="ltr" />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">التاريخ</label>
                <DatePicker value={form.date} onChange={(v) => setForm({ ...form, date: v })} className="w-full h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">ملاحظات</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full px-4 py-2 rounded-sm bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500 resize-none" />
              </div>

              <button type="button" onClick={() => setMoreOpen((v) => !v)} className="text-sm text-saffron-600 hover:text-saffron-700 font-arabic font-bold" data-testid="cost-more-toggle">
                {moreOpen ? "إخفاء التفاصيل الإضافية" : "تفاصيل إضافية"}
              </button>
              {moreOpen && (
                <div className="space-y-3 border-t border-ink-100 pt-3" data-testid="cost-more">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-arabic text-ink-900 mb-1">المستفيد</label>
                      <input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} maxLength={100} className={INPUT} />
                    </div>
                    <div>
                      <label className="block text-sm font-arabic text-ink-900 mb-1">طريقة الدفع</label>
                      <select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })} className={INPUT}>
                        <option value="">غير محددة</option>
                        {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-arabic text-ink-900 mb-1">رقم المرجع / الفاتورة</label>
                      <input value={form.reference_no} onChange={(e) => setForm({ ...form, reference_no: e.target.value })} maxLength={100} className={INPUT} dir="ltr" />
                    </div>
                    <div>
                      <label className="block text-sm font-arabic text-ink-900 mb-1">مركز التكلفة</label>
                      <input value={form.cost_centre} onChange={(e) => setForm({ ...form, cost_centre: e.target.value })} list="cost-centres" maxLength={100} placeholder="مثال: المطبخ" className={INPUT} />
                      <datalist id="cost-centres">{centres.map((c) => <option key={c} value={c} />)}</datalist>
                    </div>
                    <div>
                      <label className="block text-sm font-arabic text-ink-900 mb-1">تاريخ الدفع (إن اختلف)</label>
                      <DatePicker value={form.payment_date} onChange={(v) => setForm({ ...form, payment_date: v })} className="w-full h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-arabic text-ink-900 mb-1">عن شهر (الاستحقاق)</label>
                      <input type="month" value={form.accrual_period} onChange={(e) => setForm({ ...form, accrual_period: e.target.value })} className={`${INPUT} font-mono`} dir="ltr" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-arabic text-ink-900 mb-1">صورة الإيصال</label>
                    <div className="flex items-center gap-3">
                      {(preview || existingReceipt) && (
                        <img src={preview ?? existingReceipt ?? ""} alt="" className="w-[62px] h-[62px] rounded-md object-cover border border-ink-200" />
                      )}
                      <label className="h-9 px-4 rounded-sm bg-saffron-600 text-white text-xs font-arabic flex items-center justify-center cursor-pointer hover:bg-saffron-700">
                        {file || existingReceipt ? "تغيير الصورة" : "إرفاق صورة"}
                        <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                      </label>
                    </div>
                  </div>
                </div>
              )}
              {formError && <p className="text-sm text-danger font-arabic">{formError}</p>}
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setFormOpen(false)} className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors">إلغاء</button>
              <button onClick={save} disabled={saving} className={`${BTN} px-6`}>{saving ? "جاري..." : editId ? "حفظ" : "إضافة"}</button>
            </div>
          </div>
        </div>
      )}

      {receipt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setReceipt(null)}>
          <img src={receipt} alt="الإيصال" className="max-h-full max-w-full rounded-md bg-white" />
        </div>
      )}
    </div>
  );
}
