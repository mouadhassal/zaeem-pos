import { useCallback, useEffect, useState } from "react";
import { IconPencil, IconX } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { formatMoney, minorToInputValue, parseMoneyInput } from "../../lib/money";
import { realErrorText } from "../../lib/errors";
import { toLocalDateStr } from "../../lib/dateLocal";
import DatePicker from "../../components/ui/DatePicker";
import { PAYMENT_METHODS, RENT_PERIODS, remainingText, rentPeriodLabel } from "../../lib/finance";

interface RentMonth {
  period: string;
  due_cents: number;
  paid_cents: number;
  remaining_cents: number;
}

interface RentContract {
  id: string;
  label: string;
  period: string;
  amount_cents: number;
  start_date: string;
  end_date: string | null;
  active: boolean;
  due_cents: number;
  paid_cents: number;
  outstanding_cents: number;
  advance_cents: number;
  months: RentMonth[];
}

interface Props {
  token: string | null;
  notify: (message: string) => void;
  /** Called after a payment so the other tabs reload. */
  onChanged: () => void;
}

const INPUT = "w-full h-10 px-4 rounded-sm bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500";
const BTN = "h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-40";
const DATE_INPUT = "w-full h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500";

interface ContractForm {
  id: string | null;
  label: string;
  period: string;
  amount: string;
  start_date: string;
  end_date: string;
  active: boolean;
}

interface PayForm {
  contract: RentContract;
  amount: string;
  date: string;
  month: string;
  method: string;
  reference_no: string;
}

/** The الإيجار tab: contracts with due / paid / outstanding, a month table, and "سجّل دفعة". */
export default function RentTab({ token, notify, onChanged }: Props) {
  const [contracts, setContracts] = useState<RentContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [contractForm, setContractForm] = useState<ContractForm | null>(null);
  const [payForm, setPayForm] = useState<PayForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setContracts(await invoke<RentContract[]>("list_rent_contracts_v3", { sessionToken: token }));
    } catch (err) {
      notify(`حدث خطأ في تحميل عقود الإيجار: ${realErrorText(err)}`);
    } finally {
      setLoading(false);
    }
    // notify is a stable setter from the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const newContract = () => {
    setError(null);
    setContractForm({ id: null, label: "إيجار المحل", period: "MONTHLY", amount: "", start_date: toLocalDateStr(new Date()), end_date: "", active: true });
  };

  const editContract = (c: RentContract) => {
    setError(null);
    setContractForm({ id: c.id, label: c.label, period: c.period, amount: minorToInputValue(c.amount_cents), start_date: c.start_date, end_date: c.end_date ?? "", active: c.active });
  };

  const saveContract = async () => {
    if (!contractForm || busy) return;
    const amount = parseMoneyInput(contractForm.amount);
    if (amount <= 0) {
      setError("يرجى إدخال مبلغ صحيح");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await invoke("save_rent_contract_v3", {
        sessionToken: token,
        contractId: contractForm.id,
        label: contractForm.label,
        period: contractForm.period,
        amountCents: amount,
        startDate: contractForm.start_date,
        endDate: contractForm.end_date || null,
        active: contractForm.active,
      });
      setContractForm(null);
      notify("تم حفظ العقد");
      load();
    } catch (err) {
      setError(realErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const openPay = (contract: RentContract, month?: RentMonth) => {
    setError(null);
    const today = toLocalDateStr(new Date());
    // Offer the oldest month still owing, or the month clicked.
    const target = month ?? contract.months.find((m) => m.remaining_cents > 0);
    setPayForm({
      contract,
      amount: target && target.remaining_cents > 0 ? minorToInputValue(target.remaining_cents) : minorToInputValue(contract.amount_cents),
      date: today,
      month: target?.period ?? today.slice(0, 7),
      method: "",
      reference_no: "",
    });
  };

  const savePayment = async () => {
    if (!payForm || busy) return;
    const amount = parseMoneyInput(payForm.amount);
    if (amount <= 0) {
      setError("يرجى إدخال مبلغ صحيح");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await invoke("record_rent_payment_v3", {
        sessionToken: token,
        contractId: payForm.contract.id,
        amountCents: amount,
        date: payForm.date,
        accrualPeriod: payForm.month || null,
        paymentMethod: payForm.method || null,
        referenceNo: payForm.reference_no.trim() || null,
        notes: null,
      });
      setPayForm(null);
      notify("تم تسجيل دفعة الإيجار");
      load();
      onChanged();
    } catch (err) {
      setError(realErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const totalOutstanding = contracts.filter((c) => c.active).reduce((a, c) => a + c.outstanding_cents, 0);

  return (
    <div className="space-y-4" data-testid="rent-tab">
      <div className="flex items-center justify-between gap-3">
        <div className="bg-white rounded-md p-4 border border-ink-200 flex-1 max-w-xs">
          <p className="text-ink-400 text-sm font-arabic">إيجار مستحق غير مدفوع</p>
          <p className={`text-2xl font-bold font-mono ${totalOutstanding > 0 ? "text-danger-600" : "text-ok"}`}>{formatMoney(totalOutstanding)}</p>
        </div>
        <button onClick={newContract} className={BTN}>+ عقد إيجار</button>
      </div>

      {!loading && contracts.length === 0 && (
        <div className="zc-card p-6 text-center text-ink-500 font-arabic">
          لا توجد عقود إيجار. أضف عقداً (مبلغ ودورة وتاريخ بداية) ليحسب لك النظام المستحق والمدفوع والباقي.
        </div>
      )}

      {contracts.map((c) => (
        <div key={c.id} className={`zc-card p-4 space-y-3 ${c.active ? "" : "opacity-70"}`} data-testid="rent-contract">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-bold text-ink-900 font-arabic">
                {c.label} {!c.active && <span className="text-xs font-normal text-ink-400">(متوقف)</span>}
              </h2>
              <p className="text-xs text-ink-400 font-arabic">
                {rentPeriodLabel(c.period)} · {formatMoney(c.amount_cents)} · من {c.start_date}
                {c.end_date ? ` إلى ${c.end_date}` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => editContract(c)} className="px-3 h-9 rounded-sm border border-ink-200 text-ink-700 text-sm font-arabic hover:bg-white inline-flex items-center gap-1"><IconPencil className="w-4 h-4" /> تعديل</button>
              <button onClick={() => openPay(c)} className={`${BTN} h-9`}>سجّل دفعة</button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-md border border-ink-200 p-3">
              <p className="text-xs text-ink-400 font-arabic">المستحق حتى اليوم</p>
              <p className="font-mono font-bold text-ink-900">{formatMoney(c.due_cents)}</p>
            </div>
            <div className="rounded-md border border-ink-200 p-3">
              <p className="text-xs text-ink-400 font-arabic">المدفوع</p>
              <p className="font-mono font-bold text-ok">{formatMoney(c.paid_cents)}</p>
            </div>
            <div className="rounded-md border border-ink-200 p-3">
              <p className="text-xs text-ink-400 font-arabic">{c.advance_cents > 0 ? "مدفوع مقدماً" : "المتبقي"}</p>
              <p className={`font-mono font-bold ${c.outstanding_cents > 0 ? "text-danger-600" : "text-ink-900"}`}>{formatMoney(c.advance_cents > 0 ? c.advance_cents : c.outstanding_cents)}</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
                  <th className="text-right p-2 font-medium">الشهر</th>
                  <th className="text-right p-2 font-medium">المستحق</th>
                  <th className="text-right p-2 font-medium">المدفوع</th>
                  <th className="text-right p-2 font-medium">المتبقي</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {[...c.months].reverse().map((m) => (
                  <tr key={m.period} className="border-b border-ink-100">
                    <td className="p-2 font-mono text-ink-900">{m.period}</td>
                    <td className="p-2 font-mono">{formatMoney(m.due_cents)}</td>
                    <td className="p-2 font-mono text-ok">{formatMoney(m.paid_cents)}</td>
                    <td className={`p-2 font-arabic font-bold ${m.remaining_cents > 0 ? "text-danger-600" : "text-ink-500"}`}>{remainingText(m.remaining_cents, formatMoney)}</td>
                    <td className="p-2 text-center">
                      {m.remaining_cents > 0 && <button onClick={() => openPay(c, m)} className="text-xs text-saffron-600 hover:text-saffron-700 font-arabic font-bold">سجّل دفعة</button>}
                    </td>
                  </tr>
                ))}
                {c.months.length === 0 && <tr><td colSpan={5} className="p-3 text-center text-ink-500 font-arabic">لم يبدأ العقد بعد</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {contractForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-md shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold font-arabic text-ink-900">{contractForm.id ? "تعديل عقد إيجار" : "عقد إيجار جديد"}</h2>
              <button onClick={() => setContractForm(null)} className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center text-ink-500 shrink-0"><IconX className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">اسم العقد</label>
                <input value={contractForm.label} onChange={(e) => setContractForm({ ...contractForm, label: e.target.value })} maxLength={100} className={INPUT} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">الدورة</label>
                  <select value={contractForm.period} onChange={(e) => setContractForm({ ...contractForm, period: e.target.value })} className={INPUT}>
                    {RENT_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">المبلغ {RENT_PERIODS.find((p) => p.value === contractForm.period)?.per}</label>
                  <input type="number" min="0" step="0.01" value={contractForm.amount} onChange={(e) => setContractForm({ ...contractForm, amount: e.target.value })} className={`${INPUT} font-mono`} dir="ltr" />
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">تاريخ البداية</label>
                  <DatePicker value={contractForm.start_date} onChange={(v) => setContractForm({ ...contractForm, start_date: v })} className={DATE_INPUT} />
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">تاريخ النهاية (اختياري)</label>
                  <DatePicker value={contractForm.end_date} onChange={(v) => setContractForm({ ...contractForm, end_date: v })} className={DATE_INPUT} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm font-arabic text-ink-900 cursor-pointer">
                <input type="checkbox" checked={contractForm.active} onChange={(e) => setContractForm({ ...contractForm, active: e.target.checked })} />
                العقد ساري (أوقفه عند انتهائه فيتوقف الاستحقاق)
              </label>
              {error && <p className="text-sm text-danger font-arabic">{error}</p>}
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setContractForm(null)} className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors">إلغاء</button>
              <button onClick={saveContract} disabled={busy} className={`${BTN} px-6`}>{busy ? "جاري..." : "حفظ"}</button>
            </div>
          </div>
        </div>
      )}

      {payForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-md shadow-xl w-full max-w-md mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold font-arabic text-ink-900">دفعة إيجار — {payForm.contract.label}</h2>
              <button onClick={() => setPayForm(null)} className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center text-ink-500 shrink-0"><IconX className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">المبلغ</label>
                <input type="number" min="0" step="0.01" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} className={`${INPUT} font-mono`} dir="ltr" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">تاريخ الدفع</label>
                  <DatePicker value={payForm.date} onChange={(v) => setPayForm({ ...payForm, date: v })} className={DATE_INPUT} />
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">عن شهر</label>
                  <input type="month" value={payForm.month} onChange={(e) => setPayForm({ ...payForm, month: e.target.value })} className={`${INPUT} font-mono`} dir="ltr" />
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">طريقة الدفع</label>
                  <select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })} className={INPUT}>
                    <option value="">غير محددة</option>
                    {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">رقم المرجع</label>
                  <input value={payForm.reference_no} onChange={(e) => setPayForm({ ...payForm, reference_no: e.target.value })} maxLength={100} className={INPUT} dir="ltr" />
                </div>
              </div>
              {error && <p className="text-sm text-danger font-arabic">{error}</p>}
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setPayForm(null)} className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors">إلغاء</button>
              <button onClick={savePayment} disabled={busy} className={`${BTN} px-6`}>{busy ? "جاري..." : "تسجيل الدفعة"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
