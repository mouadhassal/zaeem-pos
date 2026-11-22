import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPencil } from "@tabler/icons-react";
import {
  bpToPercentText, listPlatformSettlements, listPlatforms, percentToBp, platformAccounts, recordPlatformSettlement,
  savePlatform, sumAccounts, type Platform, type PlatformAccount, type PlatformSettlement,
} from "../../lib/deliveryService";
import { formatMoney, minorToInputValue, parseMoneyInput } from "../../lib/money";
import { formatArabicDate } from "../../lib/dateLocal";
import { realErrorText } from "../../lib/errors";
import { useToast } from "../../hooks/useToast";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

interface PlatformDraft { id: string | null; name: string; percent: string; active: boolean }
const EMPTY: PlatformDraft = { id: null, name: "", percent: "", active: true };

/**
 * "التطبيقات": the delivery apps the owner sells through (Talabat, Jahez...) with the cut each one
 * keeps, and for a period what each owes the restaurant: sales, commission, net due, what it has
 * already paid out and what is still outstanding. Recording a payout is one button.
 */
export default function PlatformsTab() {
  const toast = useToast();
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(iso(today));
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [draft, setDraft] = useState<PlatformDraft | null>(null);
  const [settling, setSettling] = useState<{ platform: PlatformAccount; amount: string; note: string } | null>(null);
  const [history, setHistory] = useState<{ name: string; rows: PlatformSettlement[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([platformAccounts(from || undefined, to || undefined), listPlatforms(true)]);
      setAccounts(a);
      setPlatforms(p);
    } catch (e) {
      toast.error(realErrorText(e));
    }
  }, [from, to, toast]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => sumAccounts(accounts), [accounts]);

  const saveDraft = async () => {
    if (!draft) return;
    const bp = percentToBp(draft.percent);
    if (!draft.name.trim()) { toast.error("اكتب اسم التطبيق"); return; }
    if (bp === null) { toast.error("العمولة نسبة من 0 إلى 100"); return; }
    try {
      await savePlatform({ id: draft.id, name: draft.name.trim(), commission_bp: bp, active: draft.active });
      toast.success("تم حفظ التطبيق ✓");
      setDraft(null);
      await load();
    } catch (e) {
      toast.error(`تعذر الحفظ: ${realErrorText(e)}`);
    }
  };

  const saveSettlement = async () => {
    if (!settling) return;
    const amount = parseMoneyInput(settling.amount);
    if (amount <= 0) { toast.error("اكتب المبلغ الذي دفعه التطبيق"); return; }
    try {
      await recordPlatformSettlement(settling.platform.platform_id, amount, from || undefined, to || undefined, settling.note.trim() || undefined);
      toast.success("تم تسجيل التسوية ✓");
      setSettling(null);
      await load();
    } catch (e) {
      toast.error(`تعذر التسجيل: ${realErrorText(e)}`);
    }
  };

  const openHistory = async (a: PlatformAccount) => {
    try {
      setHistory({ name: a.name, rows: await listPlatformSettlements(a.platform_id, 30) });
    } catch (e) {
      toast.error(realErrorText(e));
    }
  };

  const input = "h-10 px-3 rounded-sm bg-white border-2 border-ink-200 font-arabic text-sm outline-none focus:border-saffron-600";
  const money = (v: number) => formatMoney(v);

  return (
    <div className="space-y-8" data-testid="delivery-platforms">
      <section className="rounded-md border border-ink-200 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="font-arabic font-bold text-ink-900 me-auto">حساب التطبيقات</h2>
          <label className="space-y-1"><span className="block text-xs text-ink-500 font-arabic">من</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${input} w-40`} dir="ltr" data-testid="platforms-from" /></label>
          <label className="space-y-1"><span className="block text-xs text-ink-500 font-arabic">إلى</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${input} w-40`} dir="ltr" data-testid="platforms-to" /></label>
        </div>
        <p className="font-arabic text-xs text-ink-500">المبيعات = الطلبات المدفوعة بعد المرتجعات. العمولة = المبيعات × نسبة التطبيق. المستحق لك = المبيعات − العمولة.</p>

        {accounts.length === 0 ? (
          <div className="text-center text-ink-500 font-arabic py-6">لا توجد تطبيقات بعد. أضف تطبيقاً من الأسفل، ثم اختره عند أخذ طلب سفري أو توصيل.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-arabic" data-testid="platform-accounts">
              <thead>
                <tr className="text-ink-500 text-xs border-b border-ink-200">
                  {["التطبيق", "الطلبات", "المبيعات", "العمولة", "المستحق لك", "المدفوع", "المتبقي", ""].map((h) => <th key={h} className="text-start font-medium py-2 px-2">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.platform_id} className={`border-b border-ink-100 ${a.active ? "" : "opacity-60"}`} data-testid="platform-row">
                    <td className="py-2 px-2 font-bold text-ink-900">{a.name} <span className="text-xs font-normal text-ink-500">({bpToPercentText(a.commission_bp)})</span></td>
                    <td className="py-2 px-2">{a.orders}</td>
                    <td className="py-2 px-2">{money(a.sales_cents)}</td>
                    <td className="py-2 px-2">{money(a.commission_cents)}</td>
                    <td className="py-2 px-2 font-bold">{money(a.net_due_cents)}</td>
                    <td className="py-2 px-2">{money(a.settled_cents)}</td>
                    <td className={`py-2 px-2 font-bold ${a.outstanding_cents > 0 ? "text-warn" : "text-ok"}`} data-testid="platform-outstanding">{money(a.outstanding_cents)}</td>
                    <td className="py-2 px-2 whitespace-nowrap">
                      <button onClick={() => setSettling({ platform: a, amount: a.outstanding_cents > 0 ? minorToInputValue(a.outstanding_cents) : "", note: "" })}
                        className="h-9 px-3 rounded-sm bg-saffron-600 text-white text-xs font-bold" data-testid="platform-settle">تسجيل تسوية</button>
                      <button onClick={() => void openHistory(a)} className="h-9 px-3 text-xs text-ink-500 hover:text-saffron-600">السجل</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold text-ink-900">
                  <td className="py-2 px-2">المجموع</td><td className="py-2 px-2">{totals.orders}</td><td className="py-2 px-2">{money(totals.sales_cents)}</td>
                  <td className="py-2 px-2">{money(totals.commission_cents)}</td><td className="py-2 px-2">{money(totals.net_due_cents)}</td>
                  <td className="py-2 px-2">{money(totals.settled_cents)}</td><td className="py-2 px-2">{money(totals.outstanding_cents)}</td><td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {settling && (
          <div className="rounded-md border-2 border-saffron-600 p-4 space-y-3" data-testid="settle-form">
            <p className="font-arabic text-sm text-ink-900">تسوية <b>{settling.platform.name}</b> عن الفترة {from || "—"} ← {to || "—"} (المتبقي {money(settling.platform.outstanding_cents)})</p>
            <div className="flex flex-wrap gap-3 items-end">
              <label className="space-y-1"><span className="block text-xs text-ink-500 font-arabic">المبلغ الذي دفعه التطبيق</span>
                <input value={settling.amount} onChange={(e) => setSettling({ ...settling, amount: e.target.value })} inputMode="decimal" className={`${input} w-40`} data-testid="settle-amount" /></label>
              <label className="space-y-1 flex-1 min-w-48"><span className="block text-xs text-ink-500 font-arabic">ملاحظة (اختياري)</span>
                <input value={settling.note} onChange={(e) => setSettling({ ...settling, note: e.target.value })} className={`${input} w-full`} /></label>
              <button onClick={() => setSettling(null)} className="h-10 px-5 rounded-sm bg-ink-100 text-ink-700 font-arabic font-bold">إلغاء</button>
              <button onClick={() => void saveSettlement()} className="h-10 px-6 rounded-sm bg-saffron-600 text-white font-arabic font-bold" data-testid="settle-save">حفظ</button>
            </div>
          </div>
        )}

        {history && (
          <div className="rounded-md border border-ink-200 p-4 space-y-2" data-testid="settle-history">
            <div className="flex items-center justify-between"><b className="font-arabic text-sm">تسويات {history.name}</b>
              <button onClick={() => setHistory(null)} className="text-xs text-ink-500">إغلاق</button></div>
            {history.rows.length === 0 && <p className="font-arabic text-sm text-ink-500">لا توجد تسويات بعد</p>}
            {history.rows.map((r) => (
              <div key={r.id} className="flex justify-between font-arabic text-sm border-b border-ink-100 py-1">
                <span>{formatArabicDate(new Date(r.created_at))}{r.period_to ? ` · عن ${r.period_from ?? "—"} ← ${r.period_to}` : ""}{r.note ? ` · ${r.note}` : ""}</span>
                <b>{money(r.amount_cents)}</b>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-arabic font-bold text-ink-900">التطبيقات والعمولة</h2>
          <button onClick={() => setDraft({ ...EMPTY })} className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold font-arabic" data-testid="platform-add">+ تطبيق جديد</button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {platforms.map((p) => (
            <div key={p.id} className={`rounded-md border border-ink-200 bg-white p-4 flex items-start justify-between ${p.active ? "" : "opacity-60"}`} data-testid="platform-card">
              <div className="font-arabic">
                <div className="font-bold text-ink-900">{p.name}{p.active ? "" : " (متوقف)"}</div>
                <div className="text-xs text-ink-500 mt-1">عمولة التطبيق: {bpToPercentText(p.commission_bp)}</div>
              </div>
              <button onClick={() => setDraft({ id: p.id, name: p.name, percent: String(Number((p.commission_bp / 100).toFixed(2))), active: p.active })} className="p-2 text-ink-500 hover:text-saffron-600" title="تعديل">
                <IconPencil className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
        {draft && (
          <div className="rounded-md border-2 border-saffron-600 bg-white p-5 space-y-3" data-testid="platform-form">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1"><span className="block text-xs text-ink-500 font-arabic">اسم التطبيق</span>
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${input} w-full`} data-testid="platform-name" /></label>
              <label className="space-y-1"><span className="block text-xs text-ink-500 font-arabic">عمولة التطبيق % (من المبيعات)</span>
                <input value={draft.percent} onChange={(e) => setDraft({ ...draft, percent: e.target.value })} inputMode="decimal" className={`${input} w-full`} dir="ltr" data-testid="platform-percent" /></label>
            </div>
            <label className="flex items-center gap-2 font-arabic text-sm"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> يظهر عند أخذ الطلبات</label>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDraft(null)} className="h-10 px-5 rounded-sm bg-ink-100 text-ink-700 font-arabic font-bold">إلغاء</button>
              <button onClick={() => void saveDraft()} className="h-10 px-6 rounded-sm bg-saffron-600 text-white font-arabic font-bold" data-testid="platform-save">حفظ</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
