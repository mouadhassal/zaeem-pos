import { useCallback, useEffect, useState } from "react";
import { IconPencil, IconPrinter, IconTrash, IconX } from "@tabler/icons-react";
import { printableShopName } from "../../lib/shopName";
import {
  assignDriver, listDeliveries, listDrivers, setDeliveryStatus, toCollectCents,
  type Delivery, type DeliveryStatus, type Driver,
} from "../../lib/deliveryService";
import { cancelOrder, getReceiptConfig, printKitchenChange, retrieveOpenOrder } from "../../lib/orderService";
import CancelOrderModal from "../../components/modals/CancelOrderModal";
import { useEditOrderStore } from "../../stores/editOrderStore";
import { navigateTo } from "../../lib/appNav";
import { printRows } from "../../lib/printer";
import { deliverySlipRows, deliveryStatusLabel } from "../../lib/ticketLayout";
import { useOrderLabels } from "../../lib/orderLabels";
import { formatMoney } from "../../lib/money";
import { formatArabicTime } from "../../lib/dateLocal";
import { realErrorText } from "../../lib/errors";
import { useToast } from "../../hooks/useToast";
import { usePrefsStore } from "../../stores/prefsStore";
import type { DeliveryCardSize } from "../../lib/prefs";

const OPEN: DeliveryStatus[] = ["NEW", "ASSIGNED", "OUT"];

/** A cancelled order keeps its delivery row; it is shown as cancelled, never as waiting. */
const isCancelled = (d: Delivery) => d.order_status === "CANCELLED";
const statusLabel = (d: Delivery) => (isCancelled(d) ? "ملغى" : deliveryStatusLabel(d.status));
const statusStyle = (d: Delivery) => (isCancelled(d) ? "bg-ink-100 text-ink-500" : STATUS_STYLE[d.status]);

const STATUS_STYLE: Record<DeliveryStatus, string> = {
  NEW: "bg-warn/15 text-warn",
  ASSIGNED: "bg-blue-100 text-blue-700",
  OUT: "bg-saffron-100 text-saffron-700",
  DELIVERED: "bg-green-100 text-green-700",
  FAILED: "bg-danger-soft text-danger",
};

/** How the order cards are laid out for each size the owner can pick in the preferences. */
const GRID: Record<DeliveryCardSize, string> = {
  large: "grid gap-3 lg:grid-cols-2",
  medium: "grid gap-2 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
  small: "grid gap-1.5 grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
};

interface OrderLineInfo { name: string; quantity: number; modifiers: string[]; notes: string | null }

/** Orders waiting for a driver, with a driver, or on the road; plus what finished today. */
export default function LiveTab() {
  const toast = useToast();
  const cardSize = usePrefsStore((s) => s.deliveryCardSize);
  const [open, setOpen] = useState<Delivery[]>([]);
  const [done, setDone] = useState<Delivery[]>([]);
  const labelOf = useOrderLabels([...open, ...done].map((d) => d.order_id));
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failing, setFailing] = useState<string | null>(null);
  const [failReason, setFailReason] = useState("");
  // The order whose details are open in the side panel.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lines, setLines] = useState<OrderLineInfo[] | null>(null);
  const askCancelReason = usePrefsStore((s) => s.askCancelOrderReason);
  const [cancelling, setCancelling] = useState<Delivery | null>(null);

  const load = useCallback(async () => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const [o, d, dr, openToday] = await Promise.all([
        listDeliveries({ statuses: OPEN }),
        listDeliveries({ statuses: ["DELIVERED", "FAILED"], from: today, to: today }),
        listDrivers(false),
        listDeliveries({ statuses: OPEN, from: today, to: today }),
      ]);
      setOpen([...o].filter((x) => !isCancelled(x)).reverse()); // oldest first: the one waiting longest is on top
      setDone([...d, ...openToday.filter(isCancelled)]);
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

  const selected = [...open, ...done].find((d) => d.order_id === selectedId) ?? null;

  // The panel shows what is in the order, read when it is opened.
  useEffect(() => {
    setLines(null);
    if (!selectedId) return;
    let alive = true;
    retrieveOpenOrder(selectedId)
      .then((o) => {
        if (alive) setLines((o?.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity, modifiers: i.modifiers.map((m) => m.name), notes: i.notes || null })));
      })
      .catch(() => { if (alive) setLines([]); });
    return () => { alive = false; };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedId(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId]);

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
        chainName: printableShopName(cfg.chain_name, cfg.branch_name), branchName: cfg.branch_name, orderNumber: labelOf(d.order_id), createdAt: d.created_at,
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

  const isOpen = (d: Delivery) => OPEN.includes(d.status) && !isCancelled(d);
  // Something the customer changes by phone: allowed while the order is still open and unpaid.
  const isEditable = (d: Delivery) => isOpen(d) && d.order_status !== "PAID";

  const editOrder = (d: Delivery) => {
    useEditOrderStore.getState().begin({
      orderId: d.order_id, orderType: "DELIVERY", deliveryFeeCents: d.fee_cents, address: d.address,
      customerName: d.customer_name, customerPhone: d.customer_phone, returnTo: "delivery",
    });
    navigateTo("pos");
  };

  // Cancels the whole order (the kitchen is told); the delivery leaves the list.
  const cancelDelivery = async (reason: string, pin?: string) => {
    const d = cancelling;
    if (!d) return;
    const order = await retrieveOpenOrder(d.order_id).catch(() => null);
    await cancelOrder(d.order_id, reason, pin);
    try {
      await printKitchenChange({
        kind: "CANCEL", tableName: "", orderNumber: labelOf(d.order_id), orderType: "DELIVERY", cancelReason: reason,
        items: (order?.items ?? []).map((i) => ({
          name: i.name, quantity: i.quantity, menuItemId: i.menuItemId,
          ...(i.modifiers.length ? { modifiers: i.modifiers.map((m) => m.name) } : {}),
          ...(i.notes ? { notes: i.notes } : {}),
        })),
      });
    } catch { /* the order is cancelled; a missing slip is announced by printKitchenChange */ }
    toast.success("أُلغي الطلب ✓");
    setCancelling(null);
    setSelectedId(null);
    await load();
  };

  return (
    <div className="space-y-6">
      {open.length === 0 && <div className="text-center text-ink-500 font-arabic py-10" data-testid="delivery-empty">لا توجد طلبات توصيل مفتوحة</div>}

      <div className={GRID[cardSize]} data-testid="delivery-grid" data-size={cardSize}>
        {open.map((d) => (
          <button
            type="button"
            key={d.order_id}
            onClick={() => setSelectedId(d.order_id)}
            className={`text-start rounded-md border bg-white transition-colors hover:border-saffron-500 ${selectedId === d.order_id ? "border-saffron-600 ring-2 ring-saffron-200" : "border-ink-200"} ${cardSize === "large" ? "p-4 space-y-3" : cardSize === "medium" ? "p-3 space-y-1.5" : "p-2 space-y-1"}`}
            data-testid="delivery-card"
            data-status={d.status}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className={`font-arabic font-bold text-ink-900 truncate ${cardSize === "small" ? "text-xs" : ""}`}><span dir="ltr">{labelOf(d.order_id)}</span>{cardSize !== "small" && <> · {d.customer_name || "—"}</>}</div>
                {cardSize === "large" && <div className="text-xs text-ink-500 font-mono" dir="ltr">{d.customer_phone}</div>}
              </div>
              <span className={`shrink-0 rounded-full font-arabic font-bold ${statusStyle(d)} ${cardSize === "small" ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"}`}>{statusLabel(d)}</span>
            </div>
            {cardSize !== "small" && <div className={`font-arabic text-ink-800 ${cardSize === "medium" ? "text-xs truncate" : "text-sm"}`}>{d.address}</div>}
            <div className={`flex items-center justify-between font-arabic ${cardSize === "large" ? "text-sm" : "text-xs"}`}>
              <span className="text-ink-500">{formatArabicTime(new Date(d.created_at))}</span>
              <span className="font-bold" data-testid="delivery-collect">
                {toCollectCents(d) > 0 ? (cardSize === "large" ? `يُحصَّل ${formatMoney(toCollectCents(d))}` : formatMoney(toCollectCents(d))) : "مدفوع"}
              </span>
            </div>
            {cardSize === "large" && <div className="text-xs font-arabic text-ink-500">{d.driver_name ? `السائق: ${d.driver_name}` : "بلا سائق بعد"}</div>}
          </button>
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
                  <tr key={d.order_id} onClick={() => setSelectedId(d.order_id)} className="border-t border-ink-100 cursor-pointer hover:bg-surface-alt" data-testid="delivery-done-row">
                    <td className="p-2"><span dir="ltr">{labelOf(d.order_id)}</span></td>
                    <td className="p-2">{d.address}</td>
                    <td className="p-2">{d.driver_name ?? "—"}</td>
                    <td className="p-2"><span className={`px-2 py-0.5 rounded-full text-xs font-bold ${statusStyle(d)}`}>{statusLabel(d)}</span></td>
                    <td className="p-2 tabular">{formatMoney(d.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {cancelling && (
        <CancelOrderModal
          lineCount={lines?.length ?? 0}
          totalCents={cancelling.total_cents}
          askReason={askCancelReason}
          onCancel={() => setCancelling(null)}
          onConfirm={cancelDelivery}
        />
      )}

      {/* Details: slides in from the left edge over the page. */}
      {selected && (
        <>
          <div className="fixed inset-0 bg-black/20 z-30" onClick={() => setSelectedId(null)} aria-hidden="true" />
          <aside
            className="fixed top-0 bottom-0 left-0 w-[400px] max-w-[92vw] bg-white border-r border-ink-200 shadow-2xl z-40 flex flex-col animate-[slideInLeft_180ms_ease-out]"
            dir="rtl"
            data-testid="delivery-panel"
          >
            <div className="flex items-start justify-between gap-2 p-4 border-b border-ink-200">
              <div className="min-w-0">
                <div className="font-arabic font-bold text-lg text-ink-900"><span dir="ltr">{labelOf(selected.order_id)}</span> · {selected.customer_name || "—"}</div>
                <div className="text-sm text-ink-500 font-mono" dir="ltr">{selected.customer_phone}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`px-2.5 py-1 rounded-full text-xs font-arabic font-bold ${statusStyle(selected)}`}>{statusLabel(selected)}</span>
                <button type="button" onClick={() => setSelectedId(null)} aria-label="إغلاق" data-testid="delivery-panel-close" className="w-8 h-8 rounded-lg hover:bg-surface-alt flex items-center justify-center text-ink-500"><IconX className="w-4 h-4" /></button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 font-arabic">
              <div>
                <div className="text-xs text-ink-500 mb-0.5">العنوان</div>
                <div className="text-ink-900">{selected.address || "—"}</div>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink-500">{formatArabicTime(new Date(selected.created_at))}</span>
                <span className="font-bold">{toCollectCents(selected) > 0 ? `يُحصَّل ${formatMoney(toCollectCents(selected))}` : "مدفوع"}</span>
              </div>
              <div className="text-sm"><span className="text-ink-500">السائق: </span><b>{selected.driver_name ?? "—"}</b></div>
              {selected.note && <div className="text-sm text-danger bg-danger-soft rounded-sm px-3 py-2">{selected.note}</div>}

              <div>
                <div className="text-xs text-ink-500 mb-1">الأصناف</div>
                {lines === null ? (
                  <div className="text-sm text-ink-400">…</div>
                ) : lines.length === 0 ? (
                  <div className="text-sm text-ink-400">لا تتوفر تفاصيل الأصناف</div>
                ) : (
                  <ul className="space-y-1.5" data-testid="delivery-panel-lines">
                    {lines.map((l, i) => (
                      <li key={i} className="text-sm">
                        <span className="font-bold">{l.quantity} ×</span> {l.name}
                        {l.modifiers.length > 0 && <div className="text-xs text-ink-500 ps-5">{l.modifiers.join("، ")}</div>}
                        {l.notes && <div className="text-xs text-ink-500 ps-5 italic">«{l.notes}»</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex justify-between text-sm border-t border-ink-100 pt-3">
                <span className="text-ink-500">رسوم التوصيل {formatMoney(selected.fee_cents)}</span>
                <span className="font-bold">الإجمالي {formatMoney(selected.total_cents)}</span>
              </div>
            </div>

            {isOpen(selected) && (
              <div className="p-4 border-t border-ink-200 space-y-3">
                {isEditable(selected) && (
                  <div className="flex gap-2">
                    <button onClick={() => editOrder(selected)} className="flex-1 h-10 rounded-sm bg-saffron-50 text-saffron-700 border border-saffron-200 text-sm font-bold font-arabic flex items-center justify-center gap-2" data-testid="delivery-edit">
                      <IconPencil className="w-4 h-4" />تعديل الطلب
                    </button>
                    <button onClick={() => setCancelling(selected)} className="h-10 px-4 rounded-sm bg-danger-soft text-danger text-sm font-bold font-arabic flex items-center justify-center gap-2" data-testid="delivery-cancel-order">
                      <IconTrash className="w-4 h-4" />إلغاء الطلب
                    </button>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={selected.driver_id ?? ""}
                    disabled={busy === selected.order_id}
                    onChange={(e) => act(selected.order_id, () => assignDriver(selected.order_id, e.target.value || null))}
                    className="h-10 px-3 rounded-sm bg-white border-2 border-ink-200 font-arabic text-sm outline-none focus:border-saffron-600"
                    data-testid="delivery-driver-select"
                  >
                    <option value="">اختر سائقاً...</option>
                    {drivers.map((dr) => <option key={dr.id} value={dr.id}>{dr.name}</option>)}
                  </select>
                  {selected.status === "ASSIGNED" && (
                    <button onClick={() => act(selected.order_id, () => setDeliveryStatus(selected.order_id, "OUT"))} disabled={busy === selected.order_id} className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold font-arabic" data-testid="delivery-out">خرج للتوصيل</button>
                  )}
                  {(selected.status === "ASSIGNED" || selected.status === "OUT") && (
                    <button onClick={() => act(selected.order_id, () => setDeliveryStatus(selected.order_id, "DELIVERED"), "تم التسليم ✓")} disabled={busy === selected.order_id} className="h-10 px-4 rounded-sm bg-green-600 text-white text-sm font-bold font-arabic" data-testid="delivery-delivered">تم التسليم</button>
                  )}
                  <button onClick={() => setFailing(selected.order_id)} className="h-10 px-3 rounded-sm bg-danger-soft text-danger text-sm font-bold font-arabic" data-testid="delivery-fail">فشل</button>
                  <button onClick={() => printSlip(selected)} className="h-10 w-10 rounded-sm bg-ink-100 text-ink-700 flex items-center justify-center" title="طباعة ورقة التوصيل" data-testid="delivery-print">
                    <IconPrinter className="w-4 h-4" />
                  </button>
                </div>
                {failing === selected.order_id && (
                  <div className="flex gap-2" data-testid="delivery-fail-form">
                    <input value={failReason} onChange={(e) => setFailReason(e.target.value)} placeholder="سبب الفشل (العميل لم يرد، عنوان خاطئ...)" className="flex-1 h-10 px-3 rounded-sm border-2 border-ink-200 font-arabic text-sm outline-none focus:border-danger" data-testid="delivery-fail-reason" />
                    <button onClick={() => submitFail(selected.order_id)} className="h-10 px-4 rounded-sm bg-danger text-white text-sm font-bold font-arabic" data-testid="delivery-fail-confirm">تأكيد</button>
                    <button onClick={() => { setFailing(null); setFailReason(""); }} className="h-10 px-3 rounded-sm bg-ink-100 text-ink-700 text-sm font-arabic">إلغاء</button>
                  </div>
                )}
              </div>
            )}
            {!isOpen(selected) && (
              <div className="p-4 border-t border-ink-200">
                <button onClick={() => printSlip(selected)} className="h-10 px-4 rounded-sm bg-ink-100 text-ink-700 text-sm font-arabic flex items-center gap-2" data-testid="delivery-print"><IconPrinter className="w-4 h-4" />طباعة ورقة التوصيل</button>
              </div>
            )}
          </aside>
        </>
      )}
    </div>
  );
}
