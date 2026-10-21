import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPrinter, IconFileTypePdf } from "@tabler/icons-react";
import { printableShopName } from "../../lib/shopName";
import {
  getDriverStatement, listDrivers, listSettlements, openForSettlement, settleDriver, settlementSummary,
  type Driver, type Settlement, type Statement,
} from "../../lib/deliveryService";
import { getReceiptConfig } from "../../lib/orderService";
import { printRows } from "../../lib/printer";
import { deliveryStatusLabel, driverStatementRows } from "../../lib/ticketLayout";
import { exportHtmlToPdf, pdfTableHtml } from "../../lib/pdfExport";
import { orderNo } from "../../lib/orderNumber";
import { formatMoney } from "../../lib/money";
import { formatArabicDateTime } from "../../lib/dateLocal";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";

const today = () => new Date().toLocaleDateString("en-CA");

/**
 * One driver's full statement for a period: every delivery with its address,
 * order total, fee, his pay and the cash he carries; the totals; and settling
 * with him (take his cash, hand over his pay).
 */
export default function StatementTab({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const token = useAuthStore((s) => s.token);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [driverId, setDriverId] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [st, setSt] = useState<Statement | null>(null);
  const [history, setHistory] = useState<Settlement[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listDrivers(true).then((d) => {
      setDrivers(d);
      setDriverId((cur) => cur || d.find((x) => x.is_active)?.id || d[0]?.id || "");
    }).catch((e) => toast.error(realErrorText(e)));
  }, [toast]);

  const load = useCallback(async () => {
    if (!driverId) return;
    try {
      const [s, h] = await Promise.all([getDriverStatement(driverId, from || undefined, to || undefined), listSettlements(driverId)]);
      setSt(s);
      setHistory(h);
    } catch (e) {
      toast.error(`تعذر تحميل الكشف: ${realErrorText(e)}`);
    }
  }, [driverId, from, to, toast]);

  useEffect(() => { void load(); }, [load]);

  const open = useMemo(() => (st ? openForSettlement(st.rows) : []), [st]);
  const summary = useMemo(() => settlementSummary(open), [open]);

  const settle = async () => {
    if (!st || open.length === 0) return;
    setBusy(true);
    try {
      const rec = await settleDriver(st.driver.id, open.map((r) => r.order_id), note || undefined);
      toast.success(`تمت التسوية: استلام ${formatMoney(rec.cash_cents)} ودفع ${formatMoney(rec.pay_cents)} للسائق ✓`);
      setConfirming(false);
      setNote("");
      await load();
    } catch (e) {
      toast.error(`تعذرت التسوية: ${realErrorText(e)}`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const printStatement = async () => {
    if (!st) return;
    try {
      const cfg = await getReceiptConfig();
      await printRows(driverStatementRows(printableShopName(cfg.chain_name, cfg.branch_name), st.driver.name, { from, to }, st.rows, st.totals, orderNo));
    } catch (e) {
      toast.error(`تعذرت الطباعة: ${realErrorText(e)}`);
    }
  };

  const exportPdf = async () => {
    if (!st || !token) return;
    const head = ["الطلب", "التاريخ", "العنوان", "العميل", "الحالة", "إجمالي الطلب", "رسوم التوصيل", "أجرة السائق", "نقد معه", "مسوّى"];
    const rows = st.rows.map((r) => [
      `#${orderNo(r.order_id)}`, formatArabicDateTime(new Date(r.created_at)), r.address ?? "", r.customer_name ?? "", deliveryStatusLabel(r.status),
      formatMoney(r.total_cents), formatMoney(r.fee_cents), formatMoney(r.pay_cents), formatMoney(r.cash_due_cents), r.pay_settled && r.cash_settled ? "نعم" : "لا",
    ]);
    const t = st.totals;
    const totals = [
      ["عدد التوصيلات المسلَّمة", String(t.delivered)], ["إجمالي أجرته", formatMoney(t.pay_cents)],
      ["المستحق له", formatMoney(t.pay_unsettled_cents)], ["النقد الذي معه", formatMoney(t.cash_unsettled_cents)],
    ];
    try {
      await exportHtmlToPdf(
        `driver-${st.driver.name}-${from}-${to}.pdf`,
        `<h1 style="font-size:16px">كشف حساب السائق: ${st.driver.name}</h1><p style="font-size:12px">${from} → ${to}</p>` +
          pdfTableHtml("التوصيلات", head, rows) + pdfTableHtml("الملخص", ["البند", "القيمة"], totals),
        token,
      );
      toast.success("تم حفظ الملف في مجلد التنزيلات ✓");
    } catch (e) {
      toast.error(`تعذر التصدير: ${realErrorText(e)}`);
    }
  };

  const input = "h-10 px-3 rounded-sm bg-white border-2 border-ink-200 font-arabic text-sm outline-none focus:border-saffron-600";

  return (
    <div className="space-y-5" data-testid="statement-tab">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1"><span className="block text-xs text-ink-500 font-arabic">السائق</span>
          <select value={driverId} onChange={(e) => setDriverId(e.target.value)} className={input} data-testid="statement-driver">
            {drivers.length === 0 && <option value="">لا يوجد سائقون</option>}
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_active ? "" : " (متوقف)"}</option>)}
          </select>
        </label>
        <label className="space-y-1"><span className="block text-xs text-ink-500 font-arabic">من</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={input} data-testid="statement-from" />
        </label>
        <label className="space-y-1"><span className="block text-xs text-ink-500 font-arabic">إلى</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={input} data-testid="statement-to" />
        </label>
        <div className="flex gap-2 ms-auto">
          <button onClick={printStatement} disabled={!st} className="h-10 px-4 rounded-sm bg-ink-100 text-ink-800 font-arabic text-sm font-bold flex items-center gap-1.5" data-testid="statement-print"><IconPrinter className="w-4 h-4" /> طباعة</button>
          <button onClick={exportPdf} disabled={!st} className="h-10 px-4 rounded-sm bg-ink-100 text-ink-800 font-arabic text-sm font-bold flex items-center gap-1.5" data-testid="statement-pdf"><IconFileTypePdf className="w-4 h-4" /> PDF</button>
        </div>
      </div>

      {st && (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            {[
              ["التوصيلات المسلَّمة", String(st.totals.delivered), "statement-delivered"],
              ["إجمالي أجرته", formatMoney(st.totals.pay_cents), "statement-pay-total"],
              ["المستحق له", formatMoney(st.totals.pay_unsettled_cents), "statement-pay-owed"],
              ["النقد الذي معه", formatMoney(st.totals.cash_unsettled_cents), "statement-cash"],
            ].map(([label, value, id]) => (
              <div key={id} className="rounded-md border border-ink-200 bg-white p-4">
                <div className="text-xs text-ink-500 font-arabic">{label}</div>
                <div className="text-lg font-bold tabular font-arabic" data-testid={id}>{value}</div>
              </div>
            ))}
          </div>

          <div className="rounded-md border border-ink-200 bg-white overflow-x-auto">
            <table className="w-full text-sm font-arabic" data-testid="statement-table">
              <thead className="bg-surface-alt text-ink-500">
                <tr>
                  {["الطلب", "التاريخ", "العنوان", "العميل", "الحالة", "إجمالي الطلب", "الرسوم", "أجرته", "نقد معه", "مسوّى"].map((h) => <th key={h} className="p-2 text-start whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {st.rows.length === 0 && <tr><td colSpan={10} className="p-6 text-center text-ink-500">لا توجد توصيلات في هذه الفترة</td></tr>}
                {st.rows.map((r) => (
                  <tr key={r.order_id} className="border-t border-ink-100" data-testid="statement-row">
                    <td className="p-2"><span dir="ltr">#{orderNo(r.order_id)}</span></td>
                    <td className="p-2 whitespace-nowrap">{formatArabicDateTime(new Date(r.created_at))}</td>
                    <td className="p-2">{r.address}</td>
                    <td className="p-2">{r.customer_name}</td>
                    <td className="p-2">{deliveryStatusLabel(r.status)}</td>
                    <td className="p-2 tabular">{formatMoney(r.total_cents)}</td>
                    <td className="p-2 tabular">{formatMoney(r.fee_cents)}</td>
                    <td className="p-2 tabular">{formatMoney(r.pay_cents)}</td>
                    <td className="p-2 tabular">{formatMoney(r.cash_due_cents)}</td>
                    <td className="p-2">{r.status === "DELIVERED" ? (r.pay_settled && r.cash_settled ? "✓" : "—") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-md border-2 border-saffron-600/30 bg-saffron-50 p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 font-arabic text-sm">
              <span>طلبات بانتظار التسوية: <b data-testid="settle-count">{summary.count}</b></span>
              <span>نستلم من السائق: <b className="tabular" data-testid="settle-cash">{formatMoney(summary.cash)}</b></span>
              <span>ندفع للسائق: <b className="tabular" data-testid="settle-pay">{formatMoney(summary.pay)}</b></span>
              <span>الصافي من النقد: <b className="tabular" data-testid="settle-net">{formatMoney(summary.net)}</b></span>
            </div>
            {!confirming ? (
              <button onClick={() => setConfirming(true)} disabled={open.length === 0} className="h-11 px-6 rounded-sm bg-saffron-600 text-white font-arabic font-bold disabled:opacity-40" data-testid="settle-start">
                تسوية حساب السائق
              </button>
            ) : (
              <div className="space-y-2" data-testid="settle-confirm">
                <p className="font-arabic text-sm text-ink-700">
                  سيتم تسجيل دفع {summary.count} طلب نقداً ({formatMoney(summary.cash)}) في الصندوق، وتسجيل أجرة السائق ({formatMoney(summary.pay)}). لا يمكن التراجع.
                </p>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="ملاحظة (اختياري)" className={`${input} w-full`} />
                <div className="flex gap-2">
                  <button onClick={settle} disabled={busy} className="h-11 px-6 rounded-sm bg-green-600 text-white font-arabic font-bold disabled:opacity-50" data-testid="settle-confirm-btn">{busy ? "..." : "تأكيد التسوية"}</button>
                  <button onClick={() => setConfirming(false)} className="h-11 px-4 rounded-sm bg-ink-100 text-ink-700 font-arabic">إلغاء</button>
                </div>
              </div>
            )}
            {!canManage && <p className="text-xs text-ink-500 font-arabic">تحتاج وردية مفتوحة لاستلام النقد.</p>}
          </div>

          {history.length > 0 && (
            <div className="space-y-2">
              <h3 className="font-arabic font-bold text-ink-700">تسويات سابقة</h3>
              <div className="rounded-md border border-ink-200 bg-white overflow-x-auto">
                <table className="w-full text-sm font-arabic">
                  <thead className="bg-surface-alt text-ink-500"><tr>{["التاريخ", "الطلبات", "استلمنا", "دفعنا", "ملاحظة"].map((h) => <th key={h} className="p-2 text-start">{h}</th>)}</tr></thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id} className="border-t border-ink-100" data-testid="settlement-row">
                        <td className="p-2 whitespace-nowrap">{formatArabicDateTime(new Date(h.created_at))}</td>
                        <td className="p-2">{h.deliveries_count}</td>
                        <td className="p-2 tabular">{formatMoney(h.cash_cents)}</td>
                        <td className="p-2 tabular">{formatMoney(h.pay_cents)}</td>
                        <td className="p-2">{h.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
