import { useState } from "react";
import { invoke } from "../lib/invoke";
import { realErrorText } from "../lib/errors";
import { useAuthStore } from "../stores/authStore";
import { useToast } from "../hooks/useToast";
import { formatMoney, minorToInputValue, parseMoneyInput } from "../lib/money";
import { formatArabicDateTime } from "../lib/dateLocal";
import { clampSettlement, invoiceTitle, openInvoices, previewGeneralPayment, type DebtStatement, type InvoiceLine } from "../lib/credit";

function fmtDateTime(iso: string): string {
  return formatArabicDateTime(new Date(iso), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * A credit customer's statement: every credit invoice with what was settled and what is left, a button to settle one
 * invoice (all of it or part of it) or the overall balance, and the payments in time order with the running balance.
 * Used by the debt page and by the customer page.
 */
export default function CreditStatement({ statement, onChanged }: { statement: DebtStatement; onChanged: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  // null = closed; { invoice: null } = the overall balance
  const [settle, setSettle] = useState<{ invoice: InvoiceLine | null } | null>(null);
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const open = openInvoices(statement.invoices);
  const target = settle?.invoice ?? null;
  const limit = target ? target.remaining_cents : statement.balance_cents;
  const cents = clampSettlement(parseMoneyInput(amount), limit);

  const start = (invoice: InvoiceLine | null) => {
    setSettle({ invoice });
    setAmount(minorToInputValue(invoice ? invoice.remaining_cents : statement.balance_cents));
    setNotes("");
  };

  const pay = async () => {
    if (!settle || busy || cents <= 0) return;
    setBusy(true);
    try {
      await invoke("record_debt_payment_v3", { sessionToken: token, debtorId: statement.debtor_id, amountCents: cents, notes: notes || null, orderId: target?.order_id ?? null });
      toast.success(cents >= limit ? "تم التسديد الكامل ✓" : "تم تسجيل الدفعة ✓");
      setSettle(null);
      onChanged();
    } catch (err) {
      toast.error(realErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const split = !target && cents > 0 ? previewGeneralPayment(statement.invoices, cents) : [];
  const titleOf = (id: string) => {
    const l = statement.invoices.find((x) => x.entry_id === id);
    return l ? `${invoiceTitle(l)} (${l.date})` : "";
  };

  return (
    <div className="space-y-4" data-testid="credit-statement">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-bold font-arabic text-sm text-ink-900">الفواتير الآجلة</h3>
        {statement.balance_cents > 0 && (
          <button onClick={() => start(null)} className="h-8 px-3 rounded-sm bg-saffron-600 text-white text-xs font-bold font-arabic hover:bg-saffron-700" data-testid="settle-balance">تسديد من الرصيد</button>
        )}
      </div>
      <div className="rounded-md border border-ink-200 overflow-x-auto">
        <table className="w-full text-xs font-arabic">
          <thead className="bg-surface-alt text-ink-400">
            <tr><th className="text-right p-2 font-medium">الفاتورة</th><th className="text-center p-2 font-medium">المبلغ</th><th className="text-center p-2 font-medium">سُدّد</th><th className="text-center p-2 font-medium">المتبقي</th><th className="p-2" /></tr>
          </thead>
          <tbody>
            {statement.invoices.map((l) => (
              <tr key={l.entry_id} className="border-t border-ink-100" data-testid={`invoice-${l.entry_id}`}>
                <td className="p-2"><span className="font-bold text-ink-900">{invoiceTitle(l)}</span> <span className="text-ink-400 font-mono" dir="ltr">{l.date}</span></td>
                <td className="p-2 text-center font-mono">{formatMoney(l.amount_cents)}</td>
                <td className="p-2 text-center font-mono text-ok">{l.paid_cents ? formatMoney(l.paid_cents) : "—"}</td>
                <td className={`p-2 text-center font-mono font-bold ${l.remaining_cents > 0 ? "text-danger" : "text-ink-400"}`}>{l.remaining_cents > 0 ? formatMoney(l.remaining_cents) : "مسدّدة"}</td>
                <td className="p-2 text-left">
                  {l.remaining_cents > 0 && l.order_id && (
                    <button onClick={() => start(l)} className="text-saffron-600 font-bold" data-testid={`settle-${l.entry_id}`}>تسديد</button>
                  )}
                </td>
              </tr>
            ))}
            {statement.invoices.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-ink-500">لا فواتير آجلة</td></tr>}
          </tbody>
        </table>
      </div>
      {open.length > 1 && <p className="text-[11px] font-arabic text-ink-400">التسديد من الرصيد يُحسب على أقدم فاتورة مفتوحة أولاً.</p>}

      <div className="rounded-md border border-ink-200 p-3 space-y-1">
        <h3 className="font-bold font-arabic text-sm text-ink-900">سجل المعاملات</h3>
        {statement.entries.length === 0 && <p className="text-xs text-ink-500 font-arabic">لا توجد معاملات</p>}
        {[...statement.entries].reverse().map((e) => (
          <div key={e.id} className="flex justify-between items-center text-xs py-1.5 border-b border-ink-100 last:border-0">
            <div className="flex items-center gap-2">
              <span className={`inline-block w-2 h-2 rounded-full ${e.kind === "DEBT" ? "bg-danger" : "bg-saffron-400"}`} />
              <span className="font-arabic text-ink-500">{e.kind === "DEBT" ? (e.order_id ? `فاتورة ${e.order_label ?? ""}` : "رصيد سابق") : e.order_id ? `دفعة على فاتورة ${e.order_label ?? ""}` : "دفعة"}</span>
              <span className="font-arabic text-ink-400">{fmtDateTime(e.created_at)}</span>
              {e.notes && <span className="text-ink-400">· {e.notes}</span>}
            </div>
            <div className="text-left">
              <span className={`font-mono font-bold ${e.kind === "DEBT" ? "text-danger" : "text-saffron-600"}`} dir="ltr">{e.kind === "DEBT" ? "+" : "-"}{formatMoney(e.amount_cents)}</span>
              <span className="block text-[10px] text-ink-400 font-mono" dir="ltr">= {formatMoney(e.balance_after_cents)}</span>
            </div>
          </div>
        ))}
      </div>

      {settle && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-md shadow-xl w-full max-w-sm mx-4 p-6 space-y-3" dir="rtl" data-testid="settle-modal">
            <h2 className="text-lg font-bold font-arabic text-ink-900">{target ? `تسديد ${invoiceTitle(target)}` : "تسديد من الرصيد"}</h2>
            <p className="text-sm font-arabic text-ink-500">{statement.debtor_name} · المتبقي {target ? "من الفاتورة" : "الكلي"}: <span className="font-mono font-bold text-danger">{formatMoney(limit)}</span></p>
            <div className="flex gap-2">
              <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="المبلغ" className="flex-1 h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500" dir="ltr" data-testid="settle-amount" />
              <button type="button" onClick={() => setAmount(minorToInputValue(limit))} className="h-10 px-3 rounded-sm border border-ink-200 text-xs font-arabic text-ink-700 hover:bg-surface-alt" data-testid="settle-all">الكل</button>
            </div>
            {parseMoneyInput(amount) > limit && <p className="text-xs text-warn font-arabic">المبلغ أكبر من المتبقي، سيُسجَّل {formatMoney(limit)} فقط.</p>}
            {split.length > 1 && (
              <ul className="text-[11px] font-arabic text-ink-500 space-y-0.5" data-testid="settle-split">
                {split.map((p) => <li key={p.entry_id}>{titleOf(p.entry_id)}: {formatMoney(p.take_cents)}</li>)}
              </ul>
            )}
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ملاحظات (اختياري)" className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500" />
            <div className="flex gap-2 pt-1">
              <button onClick={() => setSettle(null)} className="px-6 h-10 rounded-sm border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white">إلغاء</button>
              <button onClick={pay} disabled={busy || cents <= 0} className="flex-1 h-10 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 disabled:opacity-40" data-testid="settle-confirm">{busy ? "جاري..." : cents >= limit && cents > 0 ? "تسديد كامل" : "تسديد"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
