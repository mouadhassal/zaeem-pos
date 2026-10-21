import { useCallback, useEffect, useState } from "react";
import { IconPrinter } from "@tabler/icons-react";
import {
  assignDriver, listDeliveries, listDrivers, setDeliveryStatus, toCollectCents,
  type Delivery, type DeliveryStatus, type Driver,
} from "../../lib/deliveryService";
import { getReceiptConfig, retrieveOpenOrder } from "../../lib/orderService";
import { printRows } from "../../lib/printer";
import { deliverySlipRows, deliveryStatusLabel } from "../../lib/ticketLayout";
import { orderNo } from "../../lib/orderNumber";
import { formatMoney } from "../../lib/money";
import { formatArabicTime } from "../../lib/dateLocal";
import { realErrorText } from "../../lib/errors";
import { useToast } from "../../hooks/useToast";

const OPEN: DeliveryStatus[] = ["NEW", "ASSIGNED", "OUT"];

const STATUS_STYLE: Record<DeliveryStatus, string> = {
  NEW: "bg-warn/15 text-warn",
  ASSIGNED: "bg-blue-100 text-blue-700",
  OUT: "bg-saffron-100 text-saffron-700",
  DELIVERED: "bg-green-100 text-green-700",
  FAILED: "bg-danger-soft text-danger",
};

/** Orders waiting for a driver, with a driver, or on the road; plus what finished today. */
export default function LiveTab() {
  const toast = useToast();
  const [open, setOpen] = useState<Delivery[]>([]);
  const [done, setDone] = useState<Delivery[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failing, setFailing] = useState<string | null>(null);
  const [failReason, setFailReason] = useState("");

  const load = useCallback(async () => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const [o, d, dr] = await Promise.all([
        listDeliveries({ statuses: OPEN }),
        listDeliveries({ statuses: ["DELIVERED", "FAILED"], from: today, to: today }),
        listDrivers(false),
      ]);
      setOpen([...o].reverse()); // oldest first: the one waiting longest is on top
      setDone(d);
      setDrivers(dr);
    } catch (e) {
      toast.error(`تعذر تحميل التوصيل: ${realErrorText(e)}`);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (orderId: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(orderId);
    try {
      await fn();
      if (ok) toast.success(ok);
      await load();
    } catch (e) {
      toast.error(realErrorText(e));
    } finally {
      setBusy(null);
    }
  };

  const printSlip = async (d: Delivery) => {
    try {
      const cfg = await getReceiptConfig();
      const order = await retrieveOpenOrder(d.order_id).catch(() => null);
      await printRows(deliverySlipRows({
        chainName: cfg.chain_name, branchName: cfg.branch_name, orderNumber: orderNo(d.order_id), createdAt: d.created_at,
        ...(d.customer_name ? { customerName: d.customer_name } : {}),
        ...(d.customer_phone ? { customerPhone: d.customer_phone } : {}),
        address: d.address ?? "",
        items: (order?.items ?? []).map((i) => ({
          name: i.name, quantity: i.quantity,
          ...(i.modifiers.length ? { modifiers: i.modifiers.map((m) => m.name) } : {}),
          ...(i.notes ? { notes: i.notes } : {}),
        })),
        totalCents: d.total_cents, feeCents: d.fee_cents, paid: d.order_status === "PAID",
        ...(d.driver_name ? { driverName: d.driver_name } : {}),
      }));
    } catch (e) {
      toast.error(`تعذرت الطباعة: ${realErrorText(e)}`);
    }
  };

  const submitFail = async (orderId: string) => {
    if (!failReason.trim()) return toast.error("اكتب سبب فشل التوصيل");
    await act(orderId, () => setDeliveryStatus(orderId, "FAILED", failReason.trim()), "تم تسجيل فشل التوصيل");
    setFailing(null);
    setFailReason("");
  };

  return (
    <div className="space-y-6">
      {open.length === 0 && <div className="text-center text-ink-500 font-arabic py-10" data-testid="delivery-empty">لا توجد طلبات توصيل مفتوحة</div>}

      <div className="grid gap-3 lg:grid-cols-2">
        {open.map((d) => (
          <div key={d.order_id} className="rounded-md border border-ink-200 bg-white p-4 space-y-3" data-testid="delivery-card" data-status={d.status}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-arabic font-bold text-ink-900"><span dir="ltr">#{orderNo(d.order_id)}</span> · {d.customer_name || "—"}</div>
                <div className="text-xs text-ink-500 font-mono" dir="ltr">{d.customer_phone}</div>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-xs font-arabic font-bold ${STATUS_STYLE[d.status]}`}>{deliveryStatusLabel(d.status)}</span>
            </div>
            <div className="font-arabic text-sm text-ink-800">{d.address}</div>
            <div className="flex items-center justify-between text-sm font-arabic">
              <span className="text-ink-500">{formatArabicTime(new Date(d.created_at))}</span>
              <span className="font-bold" data-testid="delivery-collect">
                {toCollectCents(d) > 0 ? `يُحصَّل ${formatMoney(toCollectCents(d))}` : "مدفوع"}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={d.driver_id ?? ""}
                disabled={busy === d.order_id}
                onChange={(e) => act(d.order_id, () => assignDriver(d.order_id, e.target.value || null))}
                className="h-10 px-3 rounded-sm bg-white border-2 border-ink-200 font-arabic text-sm outline-none focus:border-saffron-600"
                data-testid="delivery-driver-select"
              >
                <option value="">اختر سائقاً...</option>
                {drivers.map((dr) => <option key={dr.id} value={dr.id}>{dr.name}</option>)}
              </select>
              {d.status === "ASSIGNED" && (
                <button onClick={() => act(d.order_id, () => setDeliveryStatus(d.order_id, "OUT"))} disabled={busy === d.order_id} className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold font-arabic" data-testid="delivery-out">خرج للتوصيل</button>
              )}
              {(d.status === "ASSIGNED" || d.status === "OUT") && (
                <button onClick={() => act(d.order_id, () => setDeliveryStatus(d.order_id, "DELIVERED"), "تم التسليم ✓")} disabled={busy === d.order_id} className="h-10 px-4 rounded-sm bg-green-600 text-white text-sm font-bold font-arabic" data-testid="delivery-delivered">تم التسليم</button>
              )}
              <button onClick={() => setFailing(d.order_id)} className="h-10 px-3 rounded-sm bg-danger-soft text-danger text-sm font-bold font-arabic" data-testid="delivery-fail">فشل</button>
              <button onClick={() => printSlip(d)} className="h-10 w-10 rounded-sm bg-ink-100 text-ink-700 flex items-center justify-center" title="طباعة ورقة التوصيل" data-testid="delivery-print">
                <IconPrinter className="w-4 h-4" />
              </button>
            </div>

            {failing === d.order_id && (
              <div className="flex gap-2" data-testid="delivery-fail-form">
                <input value={failReason} onChange={(e) => setFailReason(e.target.value)} placeholder="سبب الفشل (العميل لم يرد، عنوان خاطئ...)" className="flex-1 h-10 px-3 rounded-sm border-2 border-ink-200 font-arabic text-sm outline-none focus:border-danger" data-testid="delivery-fail-reason" />
                <button onClick={() => submitFail(d.order_id)} className="h-10 px-4 rounded-sm bg-danger text-white text-sm font-bold font-arabic" data-testid="delivery-fail-confirm">تأكيد</button>
                <button onClick={() => { setFailing(null); setFailReason(""); }} className="h-10 px-3 rounded-sm bg-ink-100 text-ink-700 text-sm font-arabic">إلغاء</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {done.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-arabic font-bold text-ink-700">منتهية اليوم</h2>
          <div className="rounded-md border border-ink-200 bg-white overflow-x-auto">
            <table className="w-full text-sm font-arabic">
              <thead className="bg-surface-alt text-ink-500">
                <tr>
                  <th className="p-2 text-start">الطلب</th><th className="p-2 text-start">العنوان</th><th className="p-2 text-start">السائق</th>
                  <th className="p-2 text-start">الحالة</th><th className="p-2 text-start">الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {done.map((d) => (
                  <tr key={d.order_id} className="border-t border-ink-100" data-testid="delivery-done-row">
                    <td className="p-2"><span dir="ltr">#{orderNo(d.order_id)}</span></td>
                    <td className="p-2">{d.address}</td>
                    <td className="p-2">{d.driver_name ?? "—"}</td>
                    <td className="p-2"><span className={`px-2 py-0.5 rounded-full text-xs font-bold ${STATUS_STYLE[d.status]}`}>{deliveryStatusLabel(d.status)}</span></td>
                    <td className="p-2 tabular">{formatMoney(d.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
