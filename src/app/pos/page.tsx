import { useEffect, useState, useCallback, useMemo } from "react";
import TableBar from "../../components/layout/TableBar";
import OrderTypeSelector from "../../components/ui/OrderTypeSelector";
import PaymentModal from "../../components/PaymentModal";
import ManagerPinModal from "../../components/modals/ManagerPinModal";
import SplitBillModal from "../../components/modals/SplitBillModal";
import MergeTablesModal from "../../components/modals/MergeTablesModal";
import VoidItemModal from "../../components/modals/VoidItemModal";
import TransferOrderModal from "../../components/modals/TransferOrderModal";
import OnScreenReceiptModal from "../../components/modals/OnScreenReceiptModal";
import DriverSelectModal from "../../components/modals/DriverSelectModal";
import MenuGridContainer from "./MenuGridContainer";
import OrderPanel from "../../components/ui/OrderPanel";
import PayKey from "../../components/ui/PayKey";
import {
  IconUser as User, IconAward as Award, IconTruck as Truck,
  IconArrowsSplit2 as Split, IconArrowsLeftRight as ArrowLeftRight,
  IconTag as Tag, IconPrinter as Printer, IconTrash as Trash2,
} from "@tabler/icons-react";
import { useCartStore } from "../../stores/cartStore";
import { useAuthStore } from "../../stores/authStore";
import { useShiftStore } from "../../stores/shiftStore";
import { useOrderTypeStore } from "../../stores/orderTypeStore";
import { useMenuStore } from "../../stores/menuStore";
import { CURRENCY_SYMBOLS } from "../../hooks/useCurrency";
import { usePermissions } from "../../hooks/usePermissions";
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
  const [showOrderType, setShowOrderType] = useState(false);
  const [showDriverSelect, setShowDriverSelect] = useState(false);
  const [showLoyaltyScan, setShowLoyaltyScan] = useState(false);
  const [loyaltyCard, setLoyaltyCard] = useState<{ card_number: string; customer_name: string; points: number; tier: string } | null>(null);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const [pinAction, setPinAction] = useState<string>("");
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [voidTargetItem, setVoidTargetItem] = useState<string | null>(null);
  const [voidTargetName, setVoidTargetName] = useState("");
  const [voidTargetPrice, setVoidTargetPrice] = useState(0);
  const [currencySymbol, setCurrencySymbol] = useState("ل.س");
  const [showNumpad] = useState(false);

  const { items, tableId, tableName, setTable, addItem, clearCart, setOrderType, setCustomerInfo, voidItem, updateQuantity } = useCartStore();
  const { orderType, customerName, customerPhone, deliveryAddress, driverId, resetOrderInfo, setDriverId } = useOrderTypeStore();
  const user = useAuthStore((s) => s.user);
  const shiftId = useShiftStore((s) => s.activeShiftId);
  const { maxDiscountPercent } = usePermissions();

  useEffect(() => {
    getReceiptConfig().then((cfg) => {
      setCurrencySymbol(CURRENCY_SYMBOLS[cfg.currency] || cfg.currency);
    }).catch(() => {});
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
        if (held.customerName) setCustomerInfo(held.customerName, held.customerPhone ?? "", held.deliveryAddress ?? "");
      }
    }
  };

  const handlePaymentSuccess = async (method: string, receivedCents: number, changeCents: number, debtorId?: string) => {
    if (!user || !tableId) return;
    const state = useCartStore.getState();
    const t = state.tax();
    const orderId = await createOrder(
      tableId, user.id, orderType,
      items.map((i) => ({ menuItemId: i.menuItemId, name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents, notes: i.notes, modifiers: i.modifiers })),
      state.subtotal(), t.taxCents, t.secondaryTaxCents, t.serviceChargeCents,
      state.total(), state.discountCents, state.discountReason,
      orderType !== "DINE_IN" ? customerName : undefined,
      orderType !== "DINE_IN" ? customerPhone : undefined,
      orderType === "DELIVERY" ? deliveryAddress : undefined,
      state.savingsCents, shiftId ?? undefined,
      orderType === "DELIVERY" ? driverId : undefined,
    );
    const cfg = await getReceiptConfig();
    const receipt: ReceiptData = {
      chainName: cfg.chain_name, branchName: cfg.branch_name,
      currency: cfg.currency, orderNumber: orderId.slice(0, 8),
      tableName: tableName ?? "", orderType,
      items: items.filter((i) => !i.voided).map((i) => ({ name: i.name, quantity: i.quantity, priceCents: i.unitPriceCents, modifiers: i.modifiers, ...(i.comboId ? { comboId: i.comboId } : {}) })),
      subtotalCents: state.subtotal(), taxCents: t.taxCents, secondaryTaxCents: t.secondaryTaxCents,
      serviceChargeCents: t.serviceChargeCents, discountCents: state.discountCents,
      savingsCents: state.savingsCents, totalCents: state.total(), paymentMethod: method, changeCents,
      ...(orderType !== "DINE_IN" && customerName ? { customerName } : {}),
      ...(orderType !== "DINE_IN" && customerPhone ? { customerPhone } : {}),
      ...(orderType === "DELIVERY" && deliveryAddress ? { deliveryAddress } : {}),
    };
    try {
      await finalizeOrder(orderId, method, receivedCents, changeCents, receipt, debtorId);
    } catch {
      setReceiptData(receipt);
      setShowOnScreenReceipt(true);
      setSuccessMsg("فشلت الطباعة، تم عرض الإيصال على الشاشة");
      setTimeout(() => setSuccessMsg(null), 5000);
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
  };

  const handleSplitConfirm = async (splits: SplitItem[]) => {
    if (!tableId || !user) return;
    const orderId = tables.find((t) => t.id === tableId)?.current_order_id;
    if (!orderId) return;
    await splitBill(orderId, splits.map((s) => ({ itemIds: s.itemIds, amountCents: s.amountCents, label: s.label })), user.id, tableId);
    setShowSplit(false);
    setSuccessMsg("تم تقسيم الفاتورة ✓");
    setTimeout(() => setSuccessMsg(null), 3000);
    clearCart();
    fetchTables();
  };

  const handleMergeConfirm = async (sourceIds: string[], targetId: string) => {
    if (!user) return;
    await mergeTables(sourceIds, targetId, user.id);
    setShowMerge(false);
    setSuccessMsg("تم دمج الطاولات ✓");
    setTimeout(() => setSuccessMsg(null), 3000);
    fetchTables();
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
    await transferOrder(orderId, tableId, toTableId);
    setShowTransfer(false);
    setSuccessMsg("تم نقل الطلبية ✓");
    setTimeout(() => setSuccessMsg(null), 3000);
    clearCart();
    fetchTables();
  };

  const orderLines = useMemo(() =>
    items.filter((i) => !i.voided).map((i) => ({
      id: i.id,
      name: i.name,
      categoryName: i.categoryName || "",
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
    })),
  [items]);

  const totalCents = useCartStore((s) => s.total());
  const subtotalCents = useCartStore((s) => s.subtotal());
  const discountCents = useCartStore((s) => s.discountCents);
  const orderNumber = useMemo(() => tableId?.slice(0, 8) || "0000", [tableId]);
  const currentOrderId = tables.find((t) => t.id === tableId)?.current_order_id;

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
      savingsCents: state.savingsCents, totalCents: state.total(), paymentMethod: "", changeCents: 0,
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
    <div className="flex h-full" dir="rtl">
      <div className="flex-1 flex flex-col overflow-hidden">
        {orderType !== "DINE_IN" && (
          <div className="h-12 shrink-0 bg-surface border-b border-line flex items-center gap-2 px-3 text-sm">
            <div className="flex items-center gap-1.5 text-text-muted">
              <User className="w-3.5 h-3.5" />
            </div>
            <input
              value={customerName}
              onChange={(e) => useOrderTypeStore.getState().setCustomerName(e.target.value)}
              placeholder="اسم العميل"
              className="h-8 px-2.5 rounded-[9px] border border-line text-sm w-36 bg-surface-alt focus:outline-none focus:border-accent"
            />
            <input
              value={customerPhone}
              onChange={(e) => useOrderTypeStore.getState().setCustomerPhone(e.target.value)}
              placeholder="رقم الجوال"
              className="h-8 px-2.5 rounded-[9px] border border-line text-sm w-32 bg-surface-alt focus:outline-none focus:border-accent"
              dir="ltr"
            />
            <button
              onClick={() => setShowLoyaltyScan(true)}
              className={`h-8 px-2.5 rounded-[9px] text-sm font-medium transition-all flex items-center gap-1.5 ${
                loyaltyCard ? "bg-accent-soft text-accent-text" : "bg-surface-alt text-text-3 hover:text-text-2"
              }`}
            >
              <Award className="w-3.5 h-3.5" />
              {loyaltyCard ? `${loyaltyCard.customer_name} (${loyaltyCard.points})` : "ولاء"}
            </button>
            {orderType === "DELIVERY" && (
              <>
                <input
                  value={deliveryAddress}
                  onChange={(e) => useOrderTypeStore.getState().setDeliveryAddress(e.target.value)}
                  placeholder="عنوان التوصيل"
                  className="h-8 px-2.5 rounded-[9px] border border-line text-sm flex-1 bg-surface-alt focus:outline-none focus:border-accent"
                />
                <button
                  onClick={() => setShowDriverSelect(true)}
                  className={`h-8 px-2.5 rounded-[9px] text-sm font-medium transition-all flex items-center gap-1.5 ${
                    driverId ? "bg-accent-soft text-accent-text" : "bg-surface-alt text-text-3"
                  }`}
                >
                  <Truck className="w-3.5 h-3.5" />
                  {driverId ? "سائق" : "اختيار سائق"}
                </button>
              </>
            )}
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          <MenuGridContainer
            currencySymbol={currencySymbol}
            onAddItem={(item) => {
              addItem({ ...item, modifiers: [] });
            }}
            showNumpad={showNumpad}
          />
        </div>
      </div>

      <div className="w-[226px] shrink-0 flex flex-col py-4">
        <OrderPanel
          orderNumber={orderNumber}
          lines={orderLines}
          subtotalCents={subtotalCents}
          discountCents={discountCents}
          totalCents={totalCents}
          currencySymbol={currencySymbol}
          onIncrementLine={handleIncrementLine}
          onDecrementLine={handleDecrementLine}
          onVoidLine={handleVoidLineClick}
          toolbar={
            <div className="grid grid-cols-5 gap-1.5">
              <button
                type="button"
                onClick={() => setShowOrderType(true)}
                title="نوع الطلب"
                className="h-9 rounded-[9px] bg-surface-alt text-text-2 flex items-center justify-center hover:bg-line transition-colors"
              >
                <Tag className="w-4 h-4" />
              </button>
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
            disabled={items.length === 0 || !tableId}
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

      <TableBar
        tables={tables}
        selectedId={tableId}
        onSelect={(t) => {
          if (t.status === "FREE" || t.status === "OCCUPIED") handleTableSelect(t);
        }}
        onMerge={() => setShowMerge(true)}
      />

      {showOrderType && (
        <OrderTypeSelector
          onSelect={(type) => { setOrderType(type); setShowOrderType(false); }}
          onClose={() => setShowOrderType(false)}
        />
      )}

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

      {showDriverSelect && (
        <DriverSelectModal
          selectedId={driverId}
          onSelect={(id) => { setDriverId(id); setShowDriverSelect(false); }}
          onClose={() => setShowDriverSelect(false)}
        />
      )}

      {showPayment && (
        <PaymentModal onClose={() => setShowPayment(false)} onSuccess={handlePaymentSuccess} />
      )}

      {showPin && (
        <ManagerPinModal
          title="تصريح المدير"
          description={pinAction === "discount" ? "نسبة الخصم تتجاوز الحد المسموح. يرجى إدخال كلمة مرور المدير." : "يرجى إدخال كلمة مرور المدير للمتابعة."}
          onSuccess={() => { setShowPin(false); if (pinAction === "discount") setShowPayment(true); }}
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
