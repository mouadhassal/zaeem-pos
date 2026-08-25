import { useEffect, useState, useCallback, useMemo, lazy, Suspense } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import TableBar from "../../components/layout/TableBar";
// Perf fix (post-login load lag): these 8 components are only ever needed
// once the cashier actually opens them (payment, split, merge, void,
// transfer, on-screen receipt, driver select, order-type switch) -- never
// on first paint. They were previously eager imports, bundled into the
// same chunk as the POS grid itself; Vite's own build output flagged that
// chunk at 599KB/179KB gzipped, the single largest in the app. Lazy here
// means their JS-parse cost is deferred to first actual use, off the
// critical "login -> see the menu" path entirely.
// OrderTypeSelector removed — top bar handles order type selection
const PaymentModal = lazy(() => import("../../components/PaymentModal"));
const ManagerPinModal = lazy(() => import("../../components/modals/ManagerPinModal"));
const SplitBillModal = lazy(() => import("../../components/modals/SplitBillModal"));
const MergeTablesModal = lazy(() => import("../../components/modals/MergeTablesModal"));
const VoidItemModal = lazy(() => import("../../components/modals/VoidItemModal"));
const TransferOrderModal = lazy(() => import("../../components/modals/TransferOrderModal"));
const OnScreenReceiptModal = lazy(() => import("../../components/modals/OnScreenReceiptModal"));
const DriverSelectModal = lazy(() => import("../../components/modals/DriverSelectModal"));
const DebtSelectModal = lazy(() => import("../../components/modals/DebtSelectModal"));
import MenuGridContainer from "./MenuGridContainer";
import OrderPanel from "../../components/ui/OrderPanel";
import PayKey from "../../components/ui/PayKey";
import {
  IconAward as Award, IconTruck as Truck,
  IconArrowsSplit2 as Split, IconArrowsLeftRight as ArrowLeftRight,
  IconPrinter as Printer, IconTrash as Trash2,
  IconToolsKitchen2, IconShoppingBag, IconTruckDelivery, IconWorld, IconWallet,
} from "@tabler/icons-react";
import { useCartStore } from "../../stores/cartStore";
import { useAuthStore } from "../../stores/authStore";
import { useShiftStore } from "../../stores/shiftStore";
import { useOrderTypeStore } from "../../stores/orderTypeStore";
import { useMenuStore } from "../../stores/menuStore";
import { CURRENCY_SYMBOLS } from "../../hooks/useCurrency";
import { setCurrency, parseMoneyInput } from "../../lib/money";
import { useDiscountCap } from "../../hooks/useDiscountCap";
import { createOrder, finalizeOrder, holdOrder, retrieveHeldOrder, splitBill, mergeTables, transferOrder, activateDelayedOrders, voidOrderItem, listTables, getReceiptConfig, lookupLoyaltyCard, listActiveLoyaltyRewards, redeemLoyaltyReward, getBusinessMode } from "../../lib/orderService";
import type { LoyaltyRewardOption } from "../../lib/orderService";
import { enableBarcodeScanner, disableBarcodeScanner } from "../../lib/barcodeScanner";
import { retryPrintQueue, printReceipt } from "../../lib/printer";
import { assignDriver, getZones } from "../../lib/deliveryService";
import type { ReceiptData } from "../../lib/printer";
import type { SplitItem } from "../../stores/cartStore";

interface TableData {
  id: string;
  name: string;
  status: "FREE" | "OCCUPIED" | "MERGED";
  current_order_id?: string | null;
}

export default function POSPage() {
  // WENZDES audit H10: this used to default to 6 hardcoded fake tables
  // (2 marked OCCUPIED) and never cleared them on a `listTables()` failure
  // -- an operator seeing a real-looking table grid during a genuine
  // backend outage, with no way to tell it wasn't real. `dbError` below is
  // the actual signal for that state now; an empty grid + its banner is
  // honest, a fake-but-plausible one is not.
  const [tables, setTables] = useState<TableData[]>([]);
  const [showPayment, setShowPayment] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [showSplit, setShowSplit] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [showVoid, setShowVoid] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showOnScreenReceipt, setShowOnScreenReceipt] = useState(false);
  const [showDriverSelect, setShowDriverSelect] = useState(false);
  const [showLoyaltyScan, setShowLoyaltyScan] = useState(false);
  const [showDebtSelect, setShowDebtSelect] = useState(false);
  // Split-bill payment queue (2026-08-18 persistence-bug fix): `split_bill_v3`
  // creates real PENDING orders server-side and returns their ids in
  // `splits` order -- this walks the cashier through PaymentModal once per
  // returned order id, paying each via `finalize_order_with_payment_v3`
  // (order-id-driven, doesn't touch the cart) instead of the ids being
  // discarded like before. `null` means "not currently mid a split payment".
  const [splitQueue, setSplitQueue] = useState<{
    orderId: string;
    label: string;
    amountCents: number;
    items: { name: string; quantity: number; priceCents: number; modifiers: { name: string; priceCents: number }[] }[];
  }[] | null>(null);
  const [splitQueueIndex, setSplitQueueIndex] = useState(0);
  const [loyaltyCard, setLoyaltyCard] = useState<{ card_number: string; customer_name: string; points: number; tier: string } | null>(null);
  const [loyaltyRewards, setLoyaltyRewards] = useState<LoyaltyRewardOption[]>([]);
  const [redeemingReward, setRedeemingReward] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const [pinAction, setPinAction] = useState<string>("");
  const [discountOverridePin, setDiscountOverridePin] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [voidTargetItem, setVoidTargetItem] = useState<string | null>(null);
  const [voidTargetName, setVoidTargetName] = useState("");
  const [voidTargetPrice, setVoidTargetPrice] = useState(0);
  const [currencySymbol, setCurrencySymbol] = useState("ل.س");
  const [showNumpad] = useState(false);
  // 2026-08-03 "next phase" (see nextphase.md §2) -- default true matches
  // the backend default, so the table bar/DINE_IN option never flash-hide
  // before the real value loads.
  const [hasTables, setHasTables] = useState(true);

  const { items, tableId, tableName, setTable, addItem, clearCart, voidItem, updateQuantity } = useCartStore();
  const { orderType, setOrderType, customerName, customerPhone, deliveryAddress, driverId, deliveryZoneId, deliveryFeeCents, debtorId, debtorName, resetOrderInfo, setDriverId, setDeliveryZone } = useOrderTypeStore();
  const user = useAuthStore((s) => s.user);
  const shiftId = useShiftStore((s) => s.activeShiftId);
  const setActiveShiftId = useShiftStore((s) => s.setActiveShiftId);
  // Real, server-enforced cap (chain_config via get_discount_caps_v3) --
  // replaces the old usePermissions().maxDiscountPercent, which was a
  // frontend-only constant Rust never checked (this task's whole point).
  const { yourCapPercent: maxDiscountPercent } = useDiscountCap();

  // 2026-08-25 QA re-audit ("I can't pay" report): `shiftId` used to only
  // ever get populated by actually VISITING the Shift page (shift/page.tsx
  // is the only place that ever called setActiveShiftId from a real fetch)
  // -- a cashier/manager who logged in and went straight to the POS screen
  // had a permanently-null shiftId here regardless of their REAL shift
  // status, and neither PayKey nor Hold checked it anyway. The backend has
  // always correctly required an open shift (get_active_shift(&actor.id)
  // in create_full_order_v3/hold_order_v3 -- per-staff-member, deliberately,
  // for cash-drawer accountability), so the failure mode was: add items,
  // pick a table, open payment, enter cash, hit confirm, and ONLY THEN get
  // a raw backend string ("لا توجد وردية مفتوحة") after all that work --
  // exactly reproduced live for a Manager who'd never opened one. It
  // "worked" for whichever staff happened to already have a shift open
  // from earlier in the day, by coincidence, not because this screen ever
  // checked. Fetching real status here (not just relying on the Shift page
  // having been visited first) and gating Pay/Hold on it turns a late,
  // confusing backend rejection into an upfront, obvious, fixable prompt.
  const [shiftStatusKnown, setShiftStatusKnown] = useState(false);
  useEffect(() => {
    const token = useAuthStore.getState().token;
    invoke<{ id: string } | null>("get_active_shift_v3", { sessionToken: token })
      .then((shift) => setActiveShiftId(shift?.id ?? null))
      .catch(() => {})
      .finally(() => setShiftStatusKnown(true));
  }, [setActiveShiftId]);

  const [showOpenShift, setShowOpenShift] = useState(false);
  const [openShiftStartingCash, setOpenShiftStartingCash] = useState("");
  const [openingShift, setOpeningShift] = useState(false);
  const [openShiftError, setOpenShiftError] = useState<string | null>(null);
  const handleOpenShift = async () => {
    setOpeningShift(true);
    setOpenShiftError(null);
    try {
      const token = useAuthStore.getState().token;
      const cents = parseMoneyInput(openShiftStartingCash || "0");
      const id = await invoke<string>("open_shift_v3", { sessionToken: token, startingCashCents: cents, branchId: null });
      setActiveShiftId(id);
      setShowOpenShift(false);
      setOpenShiftStartingCash("");
    } catch (err) {
      setOpenShiftError(realErrorText(err));
    } finally {
      setOpeningShift(false);
    }
  };

  useEffect(() => {
    getReceiptConfig().then((cfg) => {
      setCurrencySymbol(CURRENCY_SYMBOLS[cfg.currency] || cfg.currency);
      setCurrency(cfg.currency);
    }).catch(() => {});
    import("../../lib/taxCalculator").then((m) =>
      m.getDefaultTaxConfig().then((cfg) => useCartStore.getState().setTaxConfig(cfg)).catch(() => {})
    );
  }, []);

  const [dbError, setDbError] = useState<string | null>(null);

  const fetchTables = useCallback(async () => {
    try {
      const rows = await listTables();
      setTables(rows as TableData[]);
      setDbError(null);
    } catch (err) {
      setDbError(`تعذر تحميل الطاولات من قاعدة البيانات: ${realErrorText(err)}`);
    }
  }, []);

  useEffect(() => {
    getBusinessMode().then((m) => setHasTables(m.has_tables)).catch(() => {});
  }, []);

  // 2026-08-14 backend hardening pass: delivery zones (fee/minimum/ETA)
  // were fully configurable in Settings but never reachable from checkout
  // at all -- no zone-matching UI existed anywhere, so the fee was always
  // silently 0 regardless of what an Owner configured. No geo-matching
  // exists in this app, so the cashier picks the zone by name (same
  // manual-selection pattern as picking a table or a driver).
  const [zones, setZones] = useState<{ id: string; name: string; fee_cents: number }[]>([]);
  useEffect(() => {
    getZones().then((z) => setZones(z as { id: string; name: string; fee_cents: number }[])).catch(() => {});
  }, []);

  // 2026-08-03 "next phase": when tables are off, the cashier never picks
  // one -- the backend guarantees a "المنضدة" (Counter) table exists per
  // branch (see ensure_counter_tables_exist in commands_v3.rs), this just
  // silently attaches to it once, the first time no table is selected yet.
  useEffect(() => {
    if (!hasTables && !tableId) {
      const counter = tables.find((t) => t.name === "المنضدة");
      if (counter) setTable(counter.id, counter.name);
    }
  }, [hasTables, tables, tableId, setTable]);

  useEffect(() => {
    if (!hasTables && orderType === "DINE_IN") setOrderType("TAKEAWAY");
  }, [hasTables, orderType, setOrderType]);

  useEffect(() => {
    fetchTables();
    activateDelayedOrders();
    const interval = setInterval(() => {
      retryPrintQueue();
      activateDelayedOrders();
    }, 30000);
    enableBarcodeScanner((code) => {
      window.dispatchEvent(new CustomEvent("barcode-scanned", { detail: code }));
    });
    const handlePrintFailed = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.receipt) {
        setReceiptData(detail.receipt);
        setShowOnScreenReceipt(true);
      }
    };
    // 2026-08-02: previously silent -- see orderService.ts's doc comment
    // on this event. Long-lived (8s, not the usual 2-3s toast) since this
    // needs a cashier to actually read and act on it, not just glance.
    const handleKitchenPrintFailed = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tableName?: string } | undefined;
      setSuccessMsg(`⚠️ لم تصل الطلبية للمطبخ (${detail?.tableName ?? ""}) -- أبلغ المطبخ يدوياً، ستتم إعادة المحاولة تلقائياً`);
      setTimeout(() => setSuccessMsg(null), 8000);
    };
    const handleBarcodeScanned = (e: Event) => {
      const code = (e as CustomEvent).detail as string;
      const match = useMenuStore.getState().menuItems.find((i) => i.barcode === code);
      if (match) {
        const cat = useMenuStore.getState().categories.find((c) => c.id === match.category_id);
        addItem({
          menuItemId: match.id,
          name: match.name,
          categoryName: cat?.name || "",
          quantity: 1,
          unitPriceCents: match.price_cents,
          notes: "",
          modifiers: [],
        });
        setSuccessMsg(`تمت إضافة ${match.name} ✓`);
        setTimeout(() => setSuccessMsg(null), 2000);
      } else {
        setSuccessMsg("لم يتم العثور على صنف بهذا الباركود");
        setTimeout(() => setSuccessMsg(null), 2500);
      }
    };
    window.addEventListener("print-failed", handlePrintFailed);
    window.addEventListener("kitchen-print-failed", handleKitchenPrintFailed);
    window.addEventListener("barcode-scanned", handleBarcodeScanned);
    return () => {
      clearInterval(interval);
      disableBarcodeScanner();
      window.removeEventListener("print-failed", handlePrintFailed);
      window.removeEventListener("kitchen-print-failed", handleKitchenPrintFailed);
      window.removeEventListener("barcode-scanned", handleBarcodeScanned);
    };
  }, [fetchTables, addItem]);

  const handleHold = async () => {
    if (!user) return;
    if (!tableId && orderType === "DINE_IN") return;
    try {
      await holdOrder(
        tableId ?? "", user.id, orderType,
        items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity, unitPriceCents: i.unitPriceCents, notes: i.notes, modifiers: i.modifiers })),
        useCartStore.getState().subtotal(),
        useCartStore.getState().tax().taxCents + useCartStore.getState().tax().secondaryTaxCents + useCartStore.getState().tax().serviceChargeCents,
        useCartStore.getState().total(),
        shiftId ?? undefined
      );
      clearCart();
      resetOrderInfo();
      fetchTables();
    } catch (err) {
      setSuccessMsg(`تعذر حفظ الطلبية المعلّقة: ${realErrorText(err)}`);
      setTimeout(() => setSuccessMsg(null), 4000);
    }
  };

  useEffect(() => {
    const onPayment = () => {
      if (items.length > 0) {
        // WENZDES audit H11: subtotal() can legitimately be 0 (e.g. every
        // line fully offset by modifiers) -- dividing by it produced NaN/
        // Infinity, and `NaN > maxDiscountPercent` is always false in JS,
        // so the manager-PIN gate silently failed OPEN on that edge case.
        // (The server re-checks this independently via
        // `enforce_discount_cap`, so this was a frontend UX gap, not an
        // actual authorization bypass -- still worth closing so the prompt
        // behaves correctly instead of skipping by accident.)
        const cartSubtotal = useCartStore.getState().subtotal();
        const discountPercent = cartSubtotal > 0
          ? Math.round((useCartStore.getState().discountCents / cartSubtotal) * 100)
          : 0;
        if (discountPercent > maxDiscountPercent) {
          setPinAction("discount");
          setShowPin(true);
        } else {
          setShowPayment(true);
        }
      }
    };
    const onHold = () => handleHold();
    const onClear = () => clearCart();
    window.addEventListener("open-payment", onPayment);
    window.addEventListener("hold-order", onHold);
    window.addEventListener("clear-cart", onClear);
    return () => {
      window.removeEventListener("open-payment", onPayment);
      window.removeEventListener("hold-order", onHold);
      window.removeEventListener("clear-cart", onClear);
    };
  }, [items.length, maxDiscountPercent, handleHold, clearCart]);

  const handleTableSelect = async (table: TableData) => {
    // Switching tables mid-order used to silently keep whatever was in the
    // cart and, if the new table was occupied, ADD its held items on top --
    // no clear, no warning. Two unrelated orders (or one table's unsent
    // items plus another table's held order) would end up merged into one
    // cart and billed together with zero indication anything went wrong.
    // Auto-hold whatever's here under its own table first (same as the
    // "تعليق" button) so it's never lost or merged; if there's no table to
    // hold under yet and the destination already has its own order, block
    // instead of guessing which items belong to which bill.
    const current = useCartStore.getState();
    if (current.items.length > 0 && current.tableId !== table.id) {
      if (current.tableId) {
        await handleHold();
      } else if (table.status === "OCCUPIED" && table.current_order_id) {
        setSuccessMsg("لا يمكن تبديل الطاولة الآن -- أفرغ السلة الحالية أولاً أو علّقها");
        setTimeout(() => setSuccessMsg(null), 4000);
        return;
      }
    }
    setTable(table.id, table.name);
    if (table.status === "OCCUPIED" && table.current_order_id) {
      const held = await retrieveHeldOrder(table.current_order_id);
      if (held) {
        for (const item of held.items) {
          addItem({ ...item, modifiers: item.modifiers, notes: item.notes });
        }
        if (held.customerName) {
          useOrderTypeStore.getState().setCustomerName(held.customerName);
          if (held.customerPhone) useOrderTypeStore.getState().setCustomerPhone(held.customerPhone);
          if (held.deliveryAddress) useOrderTypeStore.getState().setDeliveryAddress(held.deliveryAddress);
        }
      }
    }
  };

  const handlePaymentSuccess = async (method: string, receivedCents: number, changeCents: number, debtorId?: string) => {
    if (!user) return;
    if (!tableId && orderType === "DINE_IN") return;
    let orderId: string;
    try {
      const state = useCartStore.getState();
      const t = state.tax();
      const effectiveMethod = orderType === "DEBT" ? "CREDIT" : method;
      const effectiveDebtorId = orderType === "DEBT" ? (debtorId ?? useOrderTypeStore.getState().debtorId) : debtorId;
      orderId = await createOrder(
        tableId ?? "", user.id, orderType === "DEBT" ? "DINE_IN" : orderType,
        items.map((i) => ({ menuItemId: i.menuItemId, name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents, notes: i.notes, modifiers: i.modifiers })),
        state.subtotal(), t.taxCents, t.secondaryTaxCents, t.serviceChargeCents,
        state.total(), state.discountCents, state.discountReason,
        orderType !== "DINE_IN" && orderType !== "DEBT" ? customerName : undefined,
        orderType !== "DINE_IN" && orderType !== "DEBT" ? customerPhone : undefined,
        orderType === "DELIVERY" ? deliveryAddress : undefined,
        state.savings(), shiftId ?? undefined,
        orderType === "DELIVERY" ? driverId : undefined,
        discountOverridePin ?? undefined,
        orderType === "DELIVERY" ? deliveryFeeCents : 0,
      );
      setDiscountOverridePin(null);

      // 2026-08-14 backend hardening pass (README.md #8's known-gaps
      // list): driverId was captured here and threaded into
      // create_full_order_v3 (a display-only field on `orders`) but
      // nothing ever created the actual `delivery_log` row --
      // assign_driver_to_delivery_v3 (already atomic: log row + driver ->
      // BUSY in one transaction, see deliveryService.ts's assignDriver
      // doc comment) existed and worked, it just had no caller at
      // checkout. The order never appeared in Delivery -> Active
      // Deliveries and its status could never be updated. Non-fatal by
      // design, same reasoning as the printing failure just below --
      // a delivery-assignment hiccup must never block a completed sale.
      if (orderType === "DELIVERY" && driverId) {
        try {
          await assignDriver(orderId, driverId);
        } catch {
          setSuccessMsg("تم البيع، لكن تعذر تعيين السائق -- عيّنه يدوياً من صفحة التوصيل");
          setTimeout(() => setSuccessMsg(null), 5000);
        }
      }

      const cfg = await getReceiptConfig();
      const receipt: ReceiptData = {
        chainName: cfg.chain_name, branchName: cfg.branch_name,
        currency: cfg.currency, orderNumber: orderId.slice(0, 8),
        tableName: tableName ?? "", orderType: orderType === "DEBT" ? "DINE_IN" : orderType,
        items: items.filter((i) => !i.voided).map((i) => ({ name: i.name, quantity: i.quantity, priceCents: i.unitPriceCents, modifiers: i.modifiers, ...(i.comboId ? { comboId: i.comboId } : {}) })),
        subtotalCents: state.subtotal(), taxCents: t.taxCents, secondaryTaxCents: t.secondaryTaxCents,
        serviceChargeCents: t.serviceChargeCents, discountCents: state.discountCents,
        savingsCents: state.savings(), totalCents: state.total() + (orderType === "DELIVERY" ? deliveryFeeCents : 0), paymentMethod: method, changeCents,
        ...(orderType !== "DINE_IN" && orderType !== "DEBT" && customerName ? { customerName } : {}),
        ...(orderType !== "DINE_IN" && orderType !== "DEBT" && customerPhone ? { customerPhone } : {}),
        ...(orderType === "DELIVERY" && deliveryAddress ? { deliveryAddress } : {}),
      };
      let pointsEarned: number | null = null;
      try {
        pointsEarned = await finalizeOrder(orderId, effectiveMethod, receivedCents, changeCents, receipt, effectiveDebtorId ?? undefined, loyaltyCard?.card_number);
      } catch {
        setReceiptData(receipt);
        setShowOnScreenReceipt(true);
        setShowPayment(false);
        setSuccessMsg("فشلت الطباعة، تم عرض الإيصال على الشاشة");
        setTimeout(() => setSuccessMsg(null), 5000);
        clearCart();
        resetOrderInfo();
        setLoyaltyCard(null);
        fetchTables();
        return;
      }
      setShowPayment(false);
      setSuccessMsg(pointsEarned ? `تم الدفع ✓ (+${pointsEarned} نقطة ولاء)` : "تم الدفع ✓");
      setTimeout(() => setSuccessMsg(null), 3000);
      clearCart();
      resetOrderInfo();
      setLoyaltyCard(null);
      fetchTables();
    } catch (err) {
      setShowPayment(false);
      setSuccessMsg(`تعذر إنشاء الطلبية: ${realErrorText(err)}`);
      setTimeout(() => setSuccessMsg(null), 4000);
    }
  };

  const handleSplitConfirm = async (splits: SplitItem[]) => {
    if (!tableId || !user) return;
    const orderId = tables.find((t) => t.id === tableId)?.current_order_id;
    if (!orderId) return;
    try {
      const splitOrderIds = await splitBill(orderId, splits.map((s) => ({ itemIds: s.itemIds, amountCents: s.amountCents, label: s.label })), user.id, tableId);
      // `Repo::split_bill` iterates `splits` in order, pushing one new order
      // id per entry -- `splitOrderIds[i]` is guaranteed to correspond to
      // `splits[i]`. Snapshot the cart items now (before `clearCart()`
      // below) so each queued payment's receipt can show its own real item
      // lines for item-toggle-based splits (manual-amount-only splits just
      // get an empty item list, same as any other amount-only line).
      const cartItemsSnapshot = items;
      const queue = splits.map((s, i) => ({
        orderId: splitOrderIds[i],
        label: s.label,
        amountCents: s.amountCents,
        items: cartItemsSnapshot
          .filter((ci) => s.itemIds.includes(ci.id) && !ci.voided)
          .map((ci) => ({ name: ci.name, quantity: ci.quantity, priceCents: ci.unitPriceCents, modifiers: ci.modifiers })),
      }));
      setShowSplit(false);
      clearCart();
      setSplitQueue(queue);
      setSplitQueueIndex(0);
      setShowPayment(true);
    } catch (err) {
      setSuccessMsg(`تعذر تقسيم الفاتورة: ${realErrorText(err)}`);
      setTimeout(() => setSuccessMsg(null), 4000);
    }
  };

  // Pays exactly one queued split order via the existing order-id-driven
  // finalize path (`finalizeOrder` -> `finalize_order_with_payment_v3`) --
  // no `createOrder` call, the order already exists (created by
  // `split_bill_v3`). Advances to the next queued split on success, or
  // closes out the whole split-payment flow once the queue is empty.
  const handleSplitPaymentSuccess = async (method: string, receivedCents: number, changeCents: number, debtorId?: string) => {
    if (!splitQueue) return;
    const current = splitQueue[splitQueueIndex];
    try {
      const cfg = await getReceiptConfig();
      const receipt: ReceiptData = {
        chainName: cfg.chain_name, branchName: cfg.branch_name,
        currency: cfg.currency, orderNumber: current.orderId.slice(0, 8),
        tableName: tableName ?? "", orderType: "DINE_IN",
        items: current.items,
        subtotalCents: current.amountCents, taxCents: 0, secondaryTaxCents: 0,
        serviceChargeCents: 0, discountCents: 0,
        savingsCents: 0, totalCents: current.amountCents, paymentMethod: method, changeCents,
      };
      await finalizeOrder(current.orderId, method, receivedCents, changeCents, receipt, debtorId);
      const nextIndex = splitQueueIndex + 1;
      if (nextIndex < splitQueue.length) {
        setSplitQueueIndex(nextIndex);
        setSuccessMsg(`تم دفع ${current.label} ✓ (${nextIndex}/${splitQueue.length})`);
        setTimeout(() => setSuccessMsg(null), 2500);
      } else {
        setShowPayment(false);
        setSplitQueue(null);
        setSplitQueueIndex(0);
        setSuccessMsg("تم دفع كل الفواتير المقسّمة ✓");
        setTimeout(() => setSuccessMsg(null), 3000);
        resetOrderInfo();
        fetchTables();
      }
    } catch (err) {
      setSuccessMsg(`تعذر دفع ${current.label}: ${realErrorText(err)}`);
      setTimeout(() => setSuccessMsg(null), 4000);
    }
  };

  const handleMergeConfirm = async (sourceIds: string[], targetId: string) => {
    if (!user) return;
    try {
      await mergeTables(sourceIds, targetId, user.id);
      setShowMerge(false);
      setSuccessMsg("تم دمج الطاولات ✓");
      setTimeout(() => setSuccessMsg(null), 3000);
      fetchTables();
    } catch (err) {
      setSuccessMsg(`تعذر دمج الطاولات: ${realErrorText(err)}`);
      setTimeout(() => setSuccessMsg(null), 4000);
    }
  };

  const handleVoidConfirm = async (reason: string, managerOverridePin?: string) => {
    if (!voidTargetItem) return;
    const target = items.find((i) => i.id === voidTargetItem);
    if (target) {
      if (target.dbItemId) {
        try {
          await voidOrderItem(target.dbItemId, reason, managerOverridePin);
        } catch (err) {
          setSuccessMsg(`تعذر حفظ الإلغاء: ${realErrorText(err)}`);
          setTimeout(() => setSuccessMsg(null), 4000);
          setShowVoid(false);
          setVoidTargetItem(null);
          return;
        }
      }
      voidItem(voidTargetItem, reason);
    }
    setShowVoid(false);
    setVoidTargetItem(null);
  };

  const handleTransferConfirm = async (toTableId: string) => {
    if (!tableId) return;
    const orderId = tables.find((t) => t.id === tableId)?.current_order_id;
    if (!orderId) return;
    try {
      await transferOrder(orderId, tableId, toTableId);
      setShowTransfer(false);
      setSuccessMsg("تم نقل الطلبية ✓");
      setTimeout(() => setSuccessMsg(null), 3000);
      clearCart();
      fetchTables();
    } catch (err) {
      setSuccessMsg(`تعذر نقل الطلبية: ${realErrorText(err)}`);
      setTimeout(() => setSuccessMsg(null), 4000);
    }
  };

  const menuItemsById = useMenuStore((s) => s.menuItems);
  const orderLines = useMemo(() =>
    items.filter((i) => !i.voided).map((i) => ({
      id: i.id,
      menuItemId: i.menuItemId,
      hasPhoto: menuItemsById.find((m) => m.id === i.menuItemId)?.image_path === "HAS_PHOTO",
      name: i.name,
      categoryName: i.categoryName || "",
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
    })),
  [items, menuItemsById]);

  const cartTotalCents = useCartStore((s) => s.total());
  // Delivery fee folded in here so OrderPanel's displayed total always
  // matches what PaymentModal collects and what orderService.ts's
  // createOrder records as total_cents -- three separate reads of the
  // same underlying number, now all consistent.
  const totalCents = cartTotalCents + (orderType === "DELIVERY" ? deliveryFeeCents : 0);
  const subtotalCents = useCartStore((s) => s.subtotal());
  const discountCents = useCartStore((s) => s.discountCents);
  const orderNumber = useMemo(() => tableId?.slice(0, 8) || "0000", [tableId]);
  const currentOrderId = tables.find((t) => t.id === tableId)?.current_order_id;

  const ORDER_TYPE_LABELS: Record<string, string> = {
    DINE_IN: "صالة", TAKEAWAY: "سفري", DELIVERY: "توصيل", ONLINE: "أونلاين", DEBT: "دين",
  };
  const ORDER_TYPE_ICONS: Record<string, typeof IconToolsKitchen2> = {
    DINE_IN: IconToolsKitchen2, TAKEAWAY: IconShoppingBag, DELIVERY: IconTruckDelivery, ONLINE: IconWorld, DEBT: IconWallet,
  };
  const OrderTypeIconComponent = ORDER_TYPE_ICONS[orderType] || IconToolsKitchen2;
  // 2026-08-03 "next phase": with tables off, `tableId` is always the
  // implicit counter table -- showing "طاولة المنضدة" ("Table Counter")
  // would be a confusing label for something the cashier never picked.
  const tableLabel = !hasTables
    ? `#${orderNumber}`
    : tableId
    ? `طاولة ${tableName} / #${orderNumber}`
    : orderType === "DINE_IN"
    ? "اختر طاولة"
    : `#${orderNumber}`;

  const handleIncrementLine = (id: string) => updateQuantity(id, 1);
  const handleDecrementLine = (id: string) => updateQuantity(id, -1);

  const handleVoidLineClick = (id: string) => {
    const target = items.find((i) => i.id === id);
    if (!target) return;
    setVoidTargetItem(id);
    setVoidTargetName(target.name);
    setVoidTargetPrice(target.unitPriceCents * target.quantity);
    setShowVoid(true);
  };

  const handlePrintDraft = async () => {
    if (items.length === 0) return;
    const state = useCartStore.getState();
    const t = state.tax();
    const cfg = await getReceiptConfig();
    const receipt: ReceiptData = {
      chainName: cfg.chain_name, branchName: cfg.branch_name,
      currency: cfg.currency, orderNumber,
      tableName: tableName ?? "", orderType,
      items: items.filter((i) => !i.voided).map((i) => ({ name: i.name, quantity: i.quantity, priceCents: i.unitPriceCents, modifiers: i.modifiers, ...(i.comboId ? { comboId: i.comboId } : {}) })),
      subtotalCents: state.subtotal(), taxCents: t.taxCents, secondaryTaxCents: t.secondaryTaxCents,
      serviceChargeCents: t.serviceChargeCents, discountCents: state.discountCents,
      savingsCents: state.savings(), totalCents: state.total() + (orderType === "DELIVERY" ? deliveryFeeCents : 0), paymentMethod: "", changeCents: 0,
      ...(orderType !== "DINE_IN" && customerName ? { customerName } : {}),
      ...(orderType !== "DINE_IN" && customerPhone ? { customerPhone } : {}),
      ...(orderType === "DELIVERY" && deliveryAddress ? { deliveryAddress } : {}),
    };
    try {
      await printReceipt(receipt);
    } catch {
      setReceiptData(receipt);
      setShowOnScreenReceipt(true);
    }
  };

  return (
    // Order panel is the FIRST child so RTL flow pins it to the physical
    // right edge of the screen (RTL start side); menu column + table bar
    // are wrapped together so the table bar spans the menu column's full
    // width instead of shrinking to its own content width.
    <div className="flex h-full" dir="rtl" data-testid="pos-page">
      <div className="w-[250px] shrink-0 h-full">
        <OrderPanel
          tableLabel={tableLabel}
          emptyMessage={orderType === "DINE_IN" ? "ما في أصناف بعد. اختر طاولة لتبدأ." : "ما في أصناف بعد. أضف صنفاً لتبدأ."}
          lines={orderLines}
          subtotalCents={subtotalCents}
          discountCents={discountCents}
          totalCents={totalCents}
          currencySymbol={currencySymbol}
          onEditOrder={() => {}} /* order type now set via top bar */
          orderTypeIcon={<OrderTypeIconComponent className="w-3.5 h-3.5" stroke={2} />}
          orderTypeLabel={ORDER_TYPE_LABELS[orderType] || orderType}
          onIncrementLine={handleIncrementLine}
          onDecrementLine={handleDecrementLine}
          onVoidLine={handleVoidLineClick}
          toolbar={
            <div className="grid grid-cols-4 gap-1.5">
              <button
                type="button"
                onClick={() => setShowSplit(true)}
                disabled={!currentOrderId}
                title="تقسيم الفاتورة"
                className="h-9 rounded-[9px] bg-surface-alt text-text-2 flex items-center justify-center hover:bg-line transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                <Split className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setShowTransfer(true)}
                disabled={!currentOrderId || !hasTables}
                title="نقل الطاولة"
                className="h-9 rounded-[9px] bg-surface-alt text-text-2 flex items-center justify-center hover:bg-line transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                <ArrowLeftRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handlePrintDraft}
                disabled={items.length === 0}
                title="طباعة الفاتورة"
                className="h-9 rounded-[9px] bg-surface-alt text-text-2 flex items-center justify-center hover:bg-line transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                <Printer className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (items.length === 0) return;
                  // Sat next to Split/Transfer/Print with identical styling
                  // and a hover-only danger cue (useless on a touch screen)
                  // -- one mistimed tap wiped the whole in-progress order
                  // with no undo. Every other destructive action in this
                  // app (void item, cancel PO, suspend staff, force-close
                  // shift) already confirms first; this one didn't.
                  if (window.confirm("هل تريد إلغاء الطلبية الحالية بالكامل؟ لا يمكن التراجع عن ذلك.")) clearCart();
                }}
                disabled={items.length === 0}
                title="إلغاء الطلبية"
                className="h-9 rounded-[9px] bg-danger-100 text-danger-600 flex items-center justify-center hover:bg-danger-600 hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          }
        >
          <PayKey
            // Not folding !shiftId into `disabled` here on purpose: a grayed-out
            // button with no explanation is exactly the confusing dead-end this
            // fix exists to remove. Pay/Hold both stay clickable with no shift
            // open and take the cashier straight to opening one instead.
            disabled={items.length === 0 || (!tableId && orderType === "DINE_IN")}
            onClick={() => {
              if (!shiftId) { setShowOpenShift(true); return; }
              const cartSubtotal = useCartStore.getState().subtotal();
              const discountPercent = cartSubtotal > 0
                ? Math.round((useCartStore.getState().discountCents / cartSubtotal) * 100)
                : 0;
              if (discountPercent > maxDiscountPercent) {
                setPinAction("discount");
                setShowPin(true);
              } else {
                setShowPayment(true);
              }
            }}
            {...(items.length > 0 ? { onHold: shiftId ? handleHold as () => void : () => setShowOpenShift(true) } : {})}
            holdDisabled={!tableId && orderType === "DINE_IN"}
          />
        </OrderPanel>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Prominent Order Type Bar - always visible for fast switching */}
        <div className="h-11 shrink-0 bg-surface border-b border-line flex items-center gap-1 px-2" dir="rtl">
          {/* 2026-08-04: DELIVERY removed from this app's own order-type
              picker on request -- the underlying delivery_service.ts/
              DriverSelectModal.tsx/app/delivery/page.tsx code all still
              exist and still work (deliberately not deleted), just
              unreachable from here now. Every `orderType === "DELIVERY"`
              branch below (customer/driver fields, payload building) is
              consequently dead but harmless -- orderType can never become
              "DELIVERY" via this picker anymore. */}
          {(["DINE_IN", "TAKEAWAY", "DEBT"] as const)
            // 2026-08-03 "next phase": DINE_IN implies a dining room --
            // meaningless once tables are off.
            .filter((t) => hasTables || t !== "DINE_IN")
            .map((t) => {
            const IconComp = ORDER_TYPE_ICONS[t] || IconToolsKitchen2;
            const isActive = orderType === t;
            return (
              <button
                key={t}
                onClick={() => {
                  setOrderType(t);
                  if (t === "DEBT") {
                    setShowDebtSelect(true);
                  } else if (t === "DINE_IN") {
                    if (!tableId) {
                      // Don't require table for DINE_IN yet - just switch
                    }
                  }
                }}
                className={`h-8 px-3 rounded-[9px] text-xs font-bold font-arabic transition-all flex items-center gap-1.5 ${
                  isActive
                    ? "bg-accent text-white"
                    : "bg-surface-alt text-text-3 hover:text-text-2 hover:bg-line"
                }`}
              >
                <IconComp className="w-3.5 h-3.5" stroke={2} />
                {ORDER_TYPE_LABELS[t] || t}
              </button>
            );
          })}
          <div className="flex-1" />
          {/* Customer info for non-DINE_IN types */}
          {orderType !== "DINE_IN" && orderType !== "DEBT" && (
            <>
              <input
                value={customerName}
                onChange={(e) => useOrderTypeStore.getState().setCustomerName(e.target.value)}
                placeholder="اسم العميل"
                className="h-7 px-2 rounded-[7px] border border-line text-xs w-28 bg-surface-alt focus:outline-none focus:border-accent font-arabic"
              />
              <input
                value={customerPhone}
                onChange={(e) => useOrderTypeStore.getState().setCustomerPhone(e.target.value)}
                placeholder="رقم الجوال"
                className="h-7 px-2 rounded-[7px] border border-line text-xs w-24 bg-surface-alt focus:outline-none focus:border-accent font-mono"
                dir="ltr"
              />
              <button
                onClick={() => setShowLoyaltyScan(true)}
                className={`h-7 px-2 rounded-[7px] text-xs font-bold transition-all flex items-center gap-1 ${
                  loyaltyCard ? "bg-accent-soft text-accent-text" : "bg-surface-alt text-text-3 hover:text-text-2"
                }`}
              >
                <Award className="w-3 h-3" />
                {loyaltyCard ? `${loyaltyCard.customer_name} (${loyaltyCard.points})` : "ولاء"}
              </button>
            </>
          )}
          {orderType === "DEBT" && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-arabic text-text-muted">
                {debtorName ? `المدين: ${debtorName}` : "اختر مدين"}
              </span>
              <button
                onClick={() => setShowDebtSelect(true)}
                className="h-7 px-2 rounded-[7px] text-xs font-bold bg-red-50 text-red-600 hover:bg-red-100 transition-all flex items-center gap-1"
              >
                <IconWallet className="w-3 h-3" />
                {debtorName ? "تغيير" : "اختيار مدين"}
              </button>
            </div>
          )}
          {orderType === "DELIVERY" && (
            <>
              <input
                value={deliveryAddress}
                onChange={(e) => useOrderTypeStore.getState().setDeliveryAddress(e.target.value)}
                placeholder="عنوان التوصيل"
                className="h-7 px-2 rounded-[7px] border border-line text-xs flex-1 min-w-[100px] bg-surface-alt focus:outline-none focus:border-accent font-arabic"
              />
              {zones.length > 0 && (
                <select
                  value={deliveryZoneId}
                  onChange={(e) => {
                    const zone = zones.find((z) => z.id === e.target.value);
                    setDeliveryZone(zone?.id ?? "", zone?.fee_cents ?? 0);
                  }}
                  className="h-7 px-2 rounded-[7px] border border-line text-xs bg-surface-alt focus:outline-none focus:border-accent font-arabic"
                >
                  <option value="">بدون منطقة</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>{z.name} ({z.fee_cents})</option>
                  ))}
                </select>
              )}
              <button
                onClick={() => setShowDriverSelect(true)}
                className={`h-7 px-2 rounded-[7px] text-xs font-bold transition-all flex items-center gap-1 ${
                  driverId ? "bg-accent-soft text-accent-text" : "bg-surface-alt text-text-3"
                }`}
              >
                <Truck className="w-3 h-3" />
                {driverId ? "سائق" : "سائق"}
              </button>
            </>
          )}
        </div>

        <div className="flex-1 overflow-hidden">
          <MenuGridContainer
            currencySymbol={currencySymbol}
            onAddItem={(item) => {
              addItem({ ...item, modifiers: [] });
            }}
            showNumpad={showNumpad}
          />
        </div>

        {hasTables && tables.length > 0 && (
          <TableBar
            tables={tables}
            selectedId={tableId}
            onSelect={(t) => {
              if (t.status === "FREE" || t.status === "OCCUPIED") handleTableSelect(t);
            }}
            onMerge={() => setShowMerge(true)}
          />
        )}
      </div>

      {/* fallback={null}: these only ever appear in response to a direct
          click (pay, split, merge, void, transfer, driver select, order
          type), so a one-frame gap before the lazy chunk resolves is
          imperceptible -- unlike the first-paint menu grid, nothing here is
          ever the thing a user is staring at waiting for on page load. */}
      {/* OrderTypeSelector removed — top bar handles order type selection */}

      {showLoyaltyScan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-surface rounded-[13px] shadow-sh-3 w-full max-w-sm mx-4 p-6 space-y-4">
            {!loyaltyCard ? (
              <>
                <h2 className="text-lg font-bold text-text">ربط بطاقة ولاء</h2>
                <p className="text-sm text-text-3">أدخل رقم بطاقة الولاء أو امسحها ضوئياً</p>
                <input
                  type="text"
                  placeholder="رقم البطاقة"
                  className="w-full h-10 px-4 rounded-[10px] border border-line text-sm tabular focus:outline-none focus:border-accent"
                  dir="ltr"
                  autoFocus
                  onKeyDown={async (e) => {
                    if (e.key === "Enter") {
                      const val = (e.target as HTMLInputElement).value.trim();
                      if (!val) return;
                      try {
                        const card = await lookupLoyaltyCard(val);
                        if (card) {
                          setLoyaltyCard(card);
                          useOrderTypeStore.getState().setCustomerName(card.customer_name);
                          if (card.customer_phone) useOrderTypeStore.getState().setCustomerPhone(card.customer_phone);
                          listActiveLoyaltyRewards().then(setLoyaltyRewards).catch(() => setLoyaltyRewards([]));
                        } else {
                          // 2026-08-04: this used to do nothing at all on a
                          // bad card number -- the cashier had no way to
                          // tell "not found" apart from "I haven't pressed
                          // Enter yet." Same shared toast every other error
                          // in this file uses.
                          setSuccessMsg("لم يتم العثور على بطاقة ولاء بهذا الرقم");
                          (e.target as HTMLInputElement).value = "";
                        }
                      } catch (err) {
                        setSuccessMsg(`تعذر البحث عن البطاقة: ${realErrorText(err)}`);
                      }
                    }
                  }}
                />
                <div className="flex justify-center">
                  <button onClick={() => setShowLoyaltyScan(false)} className="px-6 h-10 rounded-[10px] border border-line text-text-3 text-sm font-medium hover:bg-surface-alt transition-colors">إلغاء</button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-lg font-bold text-text">{loyaltyCard.customer_name}</h2>
                <p className="text-sm text-text-3">الرصيد: <span className="font-bold text-accent-text">{loyaltyCard.points}</span> نقطة -- {loyaltyCard.tier}</p>
                {redeemError && <p className="text-xs text-red-500">{redeemError}</p>}
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {loyaltyRewards.length === 0 && (
                    <p className="text-xs text-text-3 text-center py-4">لا توجد مكافآت متاحة حالياً</p>
                  )}
                  {loyaltyRewards.map((r) => {
                    const affordable = loyaltyCard.points >= r.points_cost;
                    return (
                      <button
                        key={r.id}
                        disabled={!affordable || redeemingReward}
                        onClick={async () => {
                          setRedeemError(null);
                          setRedeemingReward(true);
                          try {
                            const applied = await redeemLoyaltyReward(loyaltyCard.card_number, r.id);
                            setLoyaltyCard({ ...loyaltyCard, points: loyaltyCard.points - applied.points_cost });
                            if (applied.reward_type === "DISCOUNT_FIXED" && applied.value_cents) {
                              useCartStore.getState().setDiscount(applied.value_cents, `مكافأة ولاء: ${applied.name}`);
                            } else if (applied.reward_type === "DISCOUNT_PERCENT" && applied.value_percent_bps) {
                              const subtotal = useCartStore.getState().subtotal();
                              useCartStore.getState().setDiscount(Math.round((subtotal * applied.value_percent_bps) / 10000), `مكافأة ولاء: ${applied.name}`);
                            } else {
                              setSuccessMsg(`امنح العميل: ${applied.name}`);
                              setTimeout(() => setSuccessMsg(null), 5000);
                            }
                            setShowLoyaltyScan(false);
                          } catch (err) {
                            setRedeemError(realErrorText(err));
                          } finally {
                            setRedeemingReward(false);
                          }
                        }}
                        className={`w-full flex items-center justify-between p-3 rounded-[10px] border text-sm text-right transition-colors ${
                          affordable ? "border-line hover:border-accent hover:bg-accent-soft" : "border-line opacity-40 cursor-not-allowed"
                        }`}
                      >
                        <span className="font-medium text-text">{r.name}</span>
                        <span className="font-mono font-bold text-accent-text">{r.points_cost} نقطة</span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex justify-between gap-2">
                  <button onClick={() => { setLoyaltyCard(null); setLoyaltyRewards([]); }} className="px-4 h-10 rounded-[10px] border border-line text-text-3 text-sm font-medium hover:bg-surface-alt transition-colors">إلغاء الربط</button>
                  <button onClick={() => setShowLoyaltyScan(false)} className="px-6 h-10 rounded-[10px] bg-accent text-white text-sm font-bold hover:bg-accent-text transition-colors">إغلاق</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <Suspense fallback={null}>
      {showDriverSelect && (
        <DriverSelectModal
          selectedId={driverId}
          onSelect={(id) => { setDriverId(id); setShowDriverSelect(false); }}
          onClose={() => setShowDriverSelect(false)}
        />
      )}

      {showDebtSelect && (
        <DebtSelectModal
          onClose={() => setShowDebtSelect(false)}
          onSelect={(id, name) => {
            useOrderTypeStore.getState().setDebtor(id, name);
            setShowDebtSelect(false);
          }}
        />
      )}

      {showPayment && (
        <PaymentModal
          // Keyed by the order actually being paid so each split's turn
          // gets fresh internal state (received amount, debtor phone, etc)
          // instead of carrying over whatever was typed for the previous
          // split.
          key={splitQueue ? splitQueue[splitQueueIndex].orderId : "cart"}
          onClose={() => {
            setShowPayment(false);
            // Known limitation: closing mid-queue leaves any
            // not-yet-paid split orders as real, valid PENDING orders in
            // the DB (never lost), but there is currently no dedicated
            // "resume paying pending splits" UI to get back to them --
            // re-selecting the table only retrieves DRAFT (held) orders,
            // not PENDING ones. Clearing the queue here at least makes
            // that state visible/consistent instead of silently stuck.
            if (splitQueue) {
              setSplitQueue(null);
              setSplitQueueIndex(0);
              fetchTables();
            }
          }}
          onSuccess={splitQueue ? handleSplitPaymentSuccess : handlePaymentSuccess}
          {...(splitQueue
            ? {
                totalOverrideCents: splitQueue[splitQueueIndex].amountCents,
                subtitleOverride: `${splitQueue[splitQueueIndex].label} · ${splitQueueIndex + 1}/${splitQueue.length}`,
              }
            : orderType === "DEBT" && debtorId && debtorName
            ? { initialMethod: "CREDIT" as const, initialDebtorId: debtorId, initialDebtorName: debtorName }
            : orderType === "DEBT"
            ? { initialMethod: "CREDIT" as const }
            : {})}
        />
      )}

      {showPin && (
        <ManagerPinModal
          title="تصريح المدير"
          description={pinAction === "discount" ? "نسبة الخصم تتجاوز الحد المسموح. يرجى إدخال كلمة مرور المدير." : "يرجى إدخال كلمة مرور المدير للمتابعة."}
          onSuccess={(pin) => {
            setShowPin(false);
            if (pinAction === "discount") {
              // Forwarded as manager_override_pin to create_full_order_v3,
              // which re-verifies it server-side at order-creation time --
              // this modal's own check above is a UX pre-check, not the
              // authorization Rust actually relies on.
              setDiscountOverridePin(pin);
              setShowPayment(true);
            }
          }}
          onCancel={() => setShowPin(false)}
        />
      )}

      {showSplit && <SplitBillModal onClose={() => setShowSplit(false)} onConfirm={handleSplitConfirm} />}

      {showMerge && (
        <MergeTablesModal tables={tables} selectedTableId={tableId} onMerge={handleMergeConfirm} onCancel={() => setShowMerge(false)} />
      )}

      {showVoid && (
        <VoidItemModal itemName={voidTargetName} itemPriceCents={voidTargetPrice} onConfirm={handleVoidConfirm} onCancel={() => { setShowVoid(false); setVoidTargetItem(null); }} />
      )}

      {showTransfer && (
        <TransferOrderModal currentTable={tableId ? { id: tableId, name: tableName ?? "" } : null} tables={tables} onTransfer={handleTransferConfirm} onCancel={() => setShowTransfer(false)} />
      )}

      {showOnScreenReceipt && receiptData && (
        <OnScreenReceiptModal receiptData={receiptData} onClose={() => setShowOnScreenReceipt(false)} />
      )}
      </Suspense>

      {successMsg && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 text-white px-6 py-3 rounded-[12px] shadow-sh-3 z-50 text-sm font-medium" style={{ backgroundColor: "var(--ok)" }}>
          {successMsg}
        </div>
      )}

      {dbError && (
        <div className="fixed top-32 left-1/2 -translate-x-1/2 text-white px-6 py-3 rounded-[12px] shadow-sh-3 z-50 text-sm font-medium" style={{ backgroundColor: "var(--warn)" }}>
          {dbError}
        </div>
      )}

      {/* 2026-08-25 QA re-audit ("I can't pay" report): surfaced up front,
          before a cashier/manager gets all the way through picking a
          table/items/payment method only to hit a raw backend rejection at
          the very last step ("لا توجد وردية مفتوحة") -- see the shiftId
          fetch effect above for the full root-cause writeup. Only shown
          once the real status is known (shiftStatusKnown), so this never
          flashes on the brief moment before the fetch resolves. */}
      {shiftStatusKnown && !shiftId && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 flex items-center gap-3 text-white px-5 py-3 rounded-[12px] shadow-sh-3 z-50 text-sm font-medium" style={{ backgroundColor: "var(--warn)" }}>
          <span>لا توجد وردية مفتوحة -- افتح وردية أولاً قبل البيع</span>
          <button
            type="button"
            onClick={() => setShowOpenShift(true)}
            className="bg-white/20 hover:bg-white/30 transition-colors rounded-[8px] px-3 py-1 text-xs font-bold"
          >
            فتح وردية
          </button>
        </div>
      )}

      {showOpenShift && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={() => !openingShift && setShowOpenShift(false)}>
          <div className="bg-surface rounded-[16px] shadow-sh-3 p-6 w-[360px]" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-bold text-text mb-1">فتح وردية</h2>
            <p className="text-xs text-text-2 mb-4">أدخل المبلغ النقدي الموجود في الدرج حالياً لبدء وردية جديدة.</p>
            <label className="text-xs text-text-2 mb-1 block">المبلغ الافتتاحي</label>
            <input
              type="text"
              inputMode="numeric"
              value={openShiftStartingCash}
              onChange={(e) => setOpenShiftStartingCash(e.target.value)}
              placeholder="0"
              disabled={openingShift}
              className="w-full h-11 rounded-[10px] border border-line bg-surface-alt px-3 text-sm text-text mb-3 outline-none focus:border-accent"
              autoFocus
            />
            {openShiftError && <p className="text-xs text-danger mb-3">{openShiftError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleOpenShift}
                disabled={openingShift}
                className="flex-1 h-11 rounded-[10px] bg-accent text-white text-sm font-bold disabled:opacity-50"
              >
                {openingShift ? "جارٍ الفتح..." : "بدء الوردية"}
              </button>
              <button
                type="button"
                onClick={() => setShowOpenShift(false)}
                disabled={openingShift}
                className="h-11 px-4 rounded-[10px] bg-surface-alt text-text-2 text-sm font-medium"
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
