import { useCallback, useEffect, useState } from "react";
import { IconPencil } from "@tabler/icons-react";
import {
  describePay, getDeliverySettings, listDrivers, saveDriver, updateDeliverySettings,
  type Driver, type PayMode,
} from "../../lib/deliveryService";
import { formatMoney, minorToInputValue, parseMoneyInput } from "../../lib/money";
import { realErrorText } from "../../lib/errors";
import { useToast } from "../../hooks/useToast";

interface DriverDraft { id: string | null; name: string; phone: string; own: string; is_active: boolean }
const EMPTY: DriverDraft = { id: null, name: "", phone: "", own: "", is_active: true };

/** The owner's side of delivery: how a driver is paid, and who the drivers are. */
export default function SettingsTab() {
  const toast = useToast();
  const [mode, setMode] = useState<PayMode>("PER_DELIVERY");
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<{ mode: PayMode; value: number } | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [draft, setDraft] = useState<DriverDraft | null>(null);

  const toInput = (m: PayMode, v: number) => (m === "PER_DELIVERY" ? (v ? minorToInputValue(v) : "") : String(v));
  const fromInput = (m: PayMode, s: string) => (!s.trim() ? 0 : m === "PER_DELIVERY" ? parseMoneyInput(s) : Math.round(Number(s)));

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([getDeliverySettings(), listDrivers(true)]);
      setMode(s.pay_mode);
      setValue(toInput(s.pay_mode, s.pay_value));
      setSaved({ mode: s.pay_mode, value: s.pay_value });
      setDrivers(d);
    } catch (e) {
      toast.error(realErrorText(e));
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const saveSettings = async () => {
    try {
      await updateDeliverySettings(mode, fromInput(mode, value));
      toast.success("تم حفظ طريقة احتساب أجرة السائق ✓");
      await load();
    } catch (e) {
      toast.error(`تعذر الحفظ: ${realErrorText(e)}`);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    try {
      await saveDriver({
        id: draft.id, name: draft.name.trim(), phone: draft.phone.trim() || null,
        pay_value: draft.own.trim() ? fromInput(mode, draft.own) : null, is_active: draft.is_active,
      });
      toast.success("تم حفظ السائق ✓");
      setDraft(null);
      await load();
    } catch (e) {
      toast.error(`تعذر الحفظ: ${realErrorText(e)}`);
    }
  };

  const input = "h-10 px-3 rounded-sm bg-white border-2 border-ink-200 font-arabic text-sm outline-none focus:border-saffron-600";

  return (
    <div className="space-y-8" data-testid="delivery-settings">
      <section className="rounded-md border border-ink-200 bg-white p-5 space-y-4">
        <h2 className="font-arabic font-bold text-ink-900">أجرة السائق</h2>
        <p className="font-arabic text-sm text-ink-500">تُحسب عند تسليم الطلب وتُثبَّت عليه؛ تغيير الأجرة لاحقاً لا يغيّر التوصيلات السابقة.</p>
        <div className="flex gap-2">
          {(["PER_DELIVERY", "PERCENT_OF_FEE"] as PayMode[]).map((m) => (
            <button key={m} onClick={() => { setMode(m); setValue(""); }} data-testid={`pay-mode-${m}`}
              className={`h-11 px-5 rounded-sm font-arabic text-sm font-bold ${mode === m ? "bg-saffron-600 text-white" : "bg-ink-100 text-ink-700"}`}>
              {m === "PER_DELIVERY" ? "مبلغ ثابت لكل توصيلة" : "نسبة من رسوم التوصيل"}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-3">
          <label className="space-y-1">
            <span className="block text-xs text-ink-500 font-arabic">{mode === "PER_DELIVERY" ? "المبلغ لكل توصيلة" : "النسبة المئوية (0 - 100)"}</span>
            <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" className={`${input} w-40`} data-testid="pay-value" />
          </label>
          <button onClick={saveSettings} className="h-10 px-6 rounded-sm bg-saffron-600 text-white font-arabic font-bold" data-testid="pay-save">حفظ</button>
        </div>
        {saved && <p className="font-arabic text-sm text-ink-700" data-testid="pay-current">الحالي: {describePay(saved.mode, saved.value)}</p>}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-arabic font-bold text-ink-900">السائقون</h2>
          <button onClick={() => setDraft({ ...EMPTY })} className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold font-arabic" data-testid="driver-add">+ سائق جديد</button>
        </div>

        {drivers.length === 0 && !draft && <div className="text-center text-ink-500 font-arabic py-6">لا يوجد سائقون بعد</div>}
        <div className="grid gap-3 md:grid-cols-2">
          {drivers.map((d) => (
            <div key={d.id} className={`rounded-md border border-ink-200 bg-white p-4 flex items-start justify-between ${d.is_active ? "" : "opacity-60"}`} data-testid="driver-card">
              <div className="font-arabic">
                <div className="font-bold text-ink-900">{d.name}{d.is_active ? "" : " (متوقف)"}</div>
                <div className="text-xs text-ink-500 font-mono" dir="ltr">{d.phone}</div>
                <div className="text-xs text-ink-500 mt-1">
                  {d.pay_value != null ? `أجرته: ${mode === "PER_DELIVERY" ? formatMoney(d.pay_value) : `${d.pay_value}%`}` : "الأجرة الافتراضية"}
                </div>
              </div>
              <button onClick={() => setDraft({ id: d.id, name: d.name, phone: d.phone ?? "", own: d.pay_value != null ? toInput(mode, d.pay_value) : "", is_active: d.is_active })} className="p-2 text-ink-500 hover:text-saffron-600" title="تعديل">
                <IconPencil className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>

        {draft && (
          <div className="rounded-md border-2 border-saffron-600 bg-white p-5 space-y-3" data-testid="driver-form">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1"><span className="block text-xs text-ink-500 font-arabic">الاسم</span>
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${input} w-full`} data-testid="driver-name" /></label>
              <label className="space-y-1"><span className="block text-xs text-ink-500 font-arabic">الجوال</span>
                <input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} className={`${input} w-full`} dir="ltr" data-testid="driver-phone" /></label>
              <label className="space-y-1"><span className="block text-xs text-ink-500 font-arabic">أجرة خاصة (اتركه فارغاً للافتراضي)</span>
                <input value={draft.own} onChange={(e) => setDraft({ ...draft, own: e.target.value })} className={`${input} w-full`} inputMode="decimal" data-testid="driver-own-rate" /></label>
            </div>
            <label className="flex items-center gap-2 font-arabic text-sm"><input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} /> يعمل حالياً</label>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDraft(null)} className="h-10 px-5 rounded-sm bg-ink-100 text-ink-700 font-arabic font-bold">إلغاء</button>
              <button onClick={saveDraft} className="h-10 px-6 rounded-sm bg-saffron-600 text-white font-arabic font-bold" data-testid="driver-save">حفظ</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
