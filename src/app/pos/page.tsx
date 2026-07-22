import { useEffect, useState, useCallback, useMemo, lazy, Suspense } from "react";
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
import { useDiscountCap } from "../../hooks/useDiscountCap";
import { createOrder, finalizeOrder, holdOrder, retrieveHeldOrder, splitBill, mergeTables, transferOrder, activateDelayedOrders, voidOrderItem, listTables, getReceiptConfig, lookupLoyaltyCard, earnLoyaltyPoints } from "../../lib/orderService";
import { enableBarcodeScanner, disableBarcodeScanner } from "../../lib/barcodeScanner";
import { retryPrintQueue, printReceipt } from "../../lib/printer";
import type { ReceiptData } from "../../lib/printer";
import type { SplitItem } from "../../stores/cartStore";

interface TableData {
  id: string;
  name: string;
  status: "FREE" | "OCCUPIED" | "MERGED";
  current_order_id?: string | null;
}

const MOCK_TABLES: TableData[] = [
  { id: "t-1", name: "ط١", status: "FREE" },
  { id: "t-2", name: "ط٢", status: "OCCUPIED" },
  { id: "t-3", name: "ط٣", status: "FREE" },
  { id: "t-4", name: "ط٤", status: "FREE" },
  { id: "t-5", name: "ط٥", status: "OCCUPIED" },
  { id: "t-6", name: "ط٦", status: "FREE" },
];

export default function POSPage() {
  const [tables, setTables] = useState<TableData[]>(MOCK_TABLES);
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
  const [loyaltyCard, setLoyaltyCard] = useState<{ card_number: string; customer_name: string; points: number; tier: string } | null>(null);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const [pinAction, setPinAction] = useState<string>("");
  const [discountOverridePin, setDiscountOverridePin] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [voidTargetItem, setVoidTargetItem] = useState<string | null>(null);
  const [voidTargetName, setVoidTargetName] = useState("");
  const [voidTargetPrice, setVoidTargetPrice] = useState(0);
  const [currencySymbol, setCurrencySymbol] = useState("ل.س");
  const [showNumpad] = useState(false);

  const { items, tableId, tableName, setTable, addItem, clearCart, voidItem, updateQuantity } = useCartStore();
  const { orderType, setOrderType, customerName, customerPhone, deliveryAddress, driverId, debtorId, debtorName, resetOrderInfo, setDriverId } = useOrderTypeStore();
  const user = useAuthStore((s) => s.user);
  const shiftId = useShiftStore((s) => s.activeShiftId);
  // Real, server-enforced cap (chain_config via get_discount_caps_v3) --
  // replaces the old usePermissions().maxDiscountPercent, which was a
  // frontend-only constant Rust never checked (this task's whole point).
  const { yourCapPercent: maxDiscountPercent } = useDiscountCap();

  useEffect(() => {
    getReceiptConfig().then((cfg) => {
      setCurrencySymbol(CURRENCY_SYMBOLS[cfg.currency] || cfg.currency);
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
    } catch {
      setDbError("تعذر تحميل الطاولات من قاعدة البيانات");
    }
  }, []);

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
    window.addEventListener("barcode-scanned", handleBarcodeScanned);
    return () => {
      clearInterval(interval);
      disableBarcodeScanner();
      window.removeEventListener("print-failed", handlePrintFailed);
      window.removeEventListener("barcode-scanned", handleBarcodeScanned);
    };
  }, [fetchTables, addItem]);

  const handleHold = async () => {
    if (!user || !tableId) return;
    try {
      await holdOrder(
        tableId, user.id, orderType,
        items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity, unitPriceCents: i.unitPriceCents, notes: i.notes, modifiers: i.modifiers })),
        useCartStore.getState().subtotal(),
        useCartStore.getState().tax().taxCents + useCartStore.getState().tax().secondaryTaxCents + useCartStore.getState().tax().serviceChargeCents,
        useCartStore.getState().total(),
        shiftId ?? undefined
      );
      clearCart();
      resetOrderInfo();
      fetchTables();
    } catch {
      setSuccessMsg("تعذر حفظ الطلبية المعلّقة");
      setTimeout(() => setSuccessMsg(null), 3000);
    }
  };

  useEffect(() => {
    const onPayment = () => {
      if (items.length > 0) {
        const discountPercent = Math.round(
          (useCartStore.getState().discountCents / useCartStore.getState().subtotal()) * 100
        );
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
    if (!tableId && orderType !== "DEBT") return;
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
      );
      setDiscountOverridePin(null);
      const cfg = await getReceiptConfig();
      const receipt: ReceiptData = {
        chainName: cfg.chain_name, branchName: cfg.branch_name,
        currency: cfg.currency, orderNumber: orderId.slice(0, 8),
        tableName: tableName ?? "", orderType: orderType === "DEBT" ? "DINE_IN" : orderType,
        items: items.filter((i) => !i.voided).map((i) => ({ name: i.name, quantity: i.quantity, priceCents: i.unitPriceCents, modifiers: i.modifiers, ...(i.comboId ? { comboId: i.comboId } : {}) })),
        subtotalCents: state.subtotal(), taxCents: t.taxCents, secondaryTaxCents: t.secondaryTaxCents,
        serviceChargeCents: t.serviceChargeCents, discountCents: state.discountCents,
        savingsCents: state.savings(), totalCents: state.total(), paymentMethod: method, changeCents,
        ...(orderType !== "DINE_IN" && orderType !== "DEBT" && customerName ? { customerName } : {}),
        ...(orderType !== "DINE_IN" && orderType !== "DEBT" && customerPhone ? { customerPhone } : {}),
        ...(orderType === "DELIVERY" && deliveryAddress ? { deliveryAddress } : {}),
      };
      try {
        await finalizeOrder(orderId, effectiveMethod, receivedCents, changeCents, receipt, effectiveDebtorId ?? undefined);
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
      setSuccessMsg("تم الدفع ✓");
      setTimeout(() => setSuccessMsg(null), 3000);
      if (loyaltyCard) {
        try {
          const totalCents = useCartStore.getState().total();
          const pointsEarned = Math.floor(totalCents / 100);
          await earnLoyaltyPoints(loyaltyCard.card_number, pointsEarned, orderId);
        } catch { /* silent */ }
      }
      clearCart();
      resetOrderInfo();
      setLoyaltyCard(null);
      fetchTables();
    } catch {
      setShowPayment(false);
      setSuccessMsg("تعذر إنشاء الطلبية");
      setTimeout(() => setSuccessMsg(null), 3000);
    }
  };

  const handleSplitConfirm = async (splits: SplitItem[]) => {
    if (!tableId || !user) return;
    const orderId = tables.find((t) => t.id === tableId)?.current_order_id;
    if (!orderId) return;
    try {
      await splitBill(orderId, splits.map((s) => ({ itemIds: s.itemIds, amountCents: s.amountCents, label: s.label })), user.id, tableId);
      setShowSplit(false);
      setSuccessMsg("تم تقسيم الفاتورة ✓");
      setTimeout(() => setSuccessMsg(null), 3000);
      clearCart();
      fetchTables();
    } catch {
      setSuccessMsg("تعذر تقسيم الفاتورة");
      setTimeout(() => setSuccessMsg(null), 3000);
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
    } catch {
      setSuccessMsg("تعذر دمج الطاولات");
      setTimeout(() => setSuccessMsg(null), 3000);
    }
  };

  const handleVoidConfirm = async (reason: string) => {
    if (!voidTargetItem) return;
    const target = items.find((i) => i.id === voidTargetItem);
    if (target) {
      if (target.dbItemId) {
        try {
          await voidOrderItem(target.dbItemId, reason);
        } catch {
          setSuccessMsg("تعذر حفظ الإلغاء، حاول مجدداً");
          setTimeout(() => setSuccessMsg(null), 3000);
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
    } catch {
      setSuccessMsg("تعذر نقل الطلبية");
      setTimeout(() => setSuccessMsg(null), 3000);
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

  const totalCents = useCartStore((s) => s.total());
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
  const tableLabel = tableId
    ? `طاولة ${tableName} / #${orderNumber}`
    : "اختر طاولة";

  // Design-review placeholder only: no FX-rate backend/config exists yet.
  // Hardcoded purely so the "USD equivalent above the total" layout can be
  // reviewed -- NOT wired to any real exchange rate. Replace when a real
  // FX command exists.
  const PLACEHOLDER_SYP_PER_USD = 15000;
  const usdTotal = useMemo(() => {
    if (currencySymbol !== "ل.س" || totalCents === 0) return undefined;
    return (totalCents / 100 / PLACEHOLDER_SYP_PER_USD).toLocaleString("en-US", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }, [totalCents, currencySymbol]);

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
      savingsCents: state.savings(), totalCents: state.total(), paymentMethod: "", changeCents: 0,
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
    <div className="flex h-full" dir="rtl">
      <div className="w-[250px] shrink-0 h-full">
        <OrderPanel
          tableLabel={tableLabel}
          lines={orderLines}
          subtotalCents={subtotalCents}
          discountCents={discountCents}
          totalCents={totalCents}
          currencySymbol={currencySymbol}
          usdTotal={usdTotal}
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
                disabled={!currentOrderId}
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
                onClick={() => { if (items.length > 0) clearCart(); }}
                disabled={items.length === 0}
                title="إلغاء الطلبية"
                className="h-9 rounded-[9px] bg-surface-alt text-text-2 flex items-center justify-center hover:text-danger transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          }
        >
          <PayKey
            disabled={items.length === 0 || (!tableId && orderType !== "DEBT")}
            onClick={() => {
              const discountPercent = Math.round(
                (useCartStore.getState().discountCents / useCartStore.getState().subtotal()) * 100
              );
              if (discountPercent > maxDiscountPercent) {
                setPinAction("discount");
                setShowPin(true);
              } else {
                setShowPayment(true);
              }
            }}
            {...(items.length > 0 ? { onHold: handleHold as () => void } : {})}
          />
        </OrderPanel>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Prominent Order Type Bar - always visible for fast switching */}
        <div className="h-11 shrink-0 bg-surface border-b border-line flex items-center gap-1 px-2" dir="rtl">
          {(["DINE_IN", "TAKEAWAY", "DELIVERY", "DEBT"] as const).map((t) => {
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
                    ? "bg-accent text-white shadow-sh-1"
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

        {tables.length > 0 && (
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
                    if (card) { setLoyaltyCard(card); useOrderTypeStore.getState().setCustomerName(card.customer_name); setShowLoyaltyScan(false); }
                  } catch { /* silent */ }
                }
              }}
            />
            <div className="flex justify-center">
              <button onClick={() => setShowLoyaltyScan(false)} className="px-6 h-10 rounded-[10px] border border-line text-text-3 text-sm font-medium hover:bg-surface-alt transition-colors">إلغاء</button>
            </div>
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
          onClose={() => setShowPayment(false)}
          onSuccess={handlePaymentSuccess}
          {...(orderType === "DEBT" && debtorId && debtorName
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
    </div>
  );
}
