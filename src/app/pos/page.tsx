import { useEffect, useState, useCallback } from "react";
import LeftPanel from "../../components/layout/LeftPanel";
import RightPanel from "../../components/layout/RightPanel";
import TableBar from "../../components/layout/TableBar";
import CategoryDock from "../../components/ui/CategoryDock";
import OrderTypeSelector from "../../components/ui/OrderTypeSelector";
import PaymentModal from "../../components/PaymentModal";
import ManagerPinModal from "../../components/modals/ManagerPinModal";
import SplitBillModal from "../../components/modals/SplitBillModal";
import MergeTablesModal from "../../components/modals/MergeTablesModal";
import VoidItemModal from "../../components/modals/VoidItemModal";
import TransferOrderModal from "../../components/modals/TransferOrderModal";
import OnScreenReceiptModal from "../../components/modals/OnScreenReceiptModal";
import DriverSelectModal from "../../components/modals/DriverSelectModal";
import MenuGrid from "../../components/MenuGrid";
import { sql } from "kysely";
import { Truck, User, Award } from "lucide-react";
import { useCartStore } from "../../stores/cartStore";
import { useAuthStore } from "../../stores/authStore";
import { useShiftStore } from "../../stores/shiftStore";
import { useOrderTypeStore } from "../../stores/orderTypeStore";
import { usePermissions } from "../../hooks/usePermissions";
import { getDb } from "../../db";
import { createOrder, finalizeOrder, holdOrder, retrieveHeldOrder, splitBill, mergeTables, transferOrder, activateDelayedOrders } from "../../lib/orderService";
import { enableBarcodeScanner, disableBarcodeScanner } from "../../lib/barcodeScanner";
import { retryPrintQueue } from "../../lib/printer";
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
  const { items, tableId, tableName, setTable, addItem, clearCart, setOrderType, setCustomerInfo, voidItem } = useCartStore();
  const { orderType, customerName, customerPhone, deliveryAddress, driverId, resetOrderInfo, setDriverId } = useOrderTypeStore();
  const user = useAuthStore((s) => s.user);
  const shiftId = useShiftStore((s) => s.activeShiftId);
  const { maxDiscountPercent } = usePermissions();

  const [dbError, setDbError] = useState<string | null>(null);

  const fetchTables = useCallback(async () => {
    try {
      const db = await getDb();
      const rows = await db
        .selectFrom("tables")
        .select(["id", "name", "status", "current_order_id"])
        .execute();
      setTables(rows as TableData[]);
      setDbError(null);
    } catch (e) {
      console.error("Failed to fetch tables, using mock data:", e);
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
      const menuEvent = new CustomEvent("barcode-scanned", { detail: code });
      window.dispatchEvent(menuEvent);
    });

    const handlePrintFailed = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.receipt) {
        setReceiptData(detail.receipt);
        setShowOnScreenReceipt(true);
      }
    };
    window.addEventListener("print-failed", handlePrintFailed);

    return () => {
      clearInterval(interval);
      disableBarcodeScanner();
      window.removeEventListener("print-failed", handlePrintFailed);
    };
  }, []);

  const handleHold = async () => {
    if (!user || !tableId) return;
    await holdOrder(
      tableId,
      user.id,
      orderType,
      items.map((i) => ({
        menuItemId: i.menuItemId,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
        notes: i.notes,
        modifiers: i.modifiers,
      })),
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
          (useCartStore.getState().discountCents / useCartStore.getState().subtotal()) *
            100
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
    const onPrint = () => {
      window.dispatchEvent(new CustomEvent("open-payment"));
    };

    window.addEventListener("open-payment", onPayment);
    window.addEventListener("hold-order", onHold);
    window.addEventListener("clear-cart", onClear);
    window.addEventListener("print-receipt", onPrint);

    return () => {
      window.removeEventListener("open-payment", onPayment);
      window.removeEventListener("hold-order", onHold);
      window.removeEventListener("clear-cart", onClear);
      window.removeEventListener("print-receipt", onPrint);
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
      tableId,
      user.id,
      orderType,
      items.map((i) => ({
        menuItemId: i.menuItemId,
        name: i.name,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
        notes: i.notes,
        modifiers: i.modifiers,
      })),
      state.subtotal(),
      t.taxCents,
      t.secondaryTaxCents,
      t.serviceChargeCents,
      state.total(),
      state.discountCents,
      state.discountReason,
      orderType !== "DINE_IN" ? customerName : undefined,
      orderType !== "DINE_IN" ? customerPhone : undefined,
      orderType === "DELIVERY" ? deliveryAddress : undefined,
      state.savingsCents,
      shiftId ?? undefined,
      orderType === "DELIVERY" ? driverId : undefined,
    );

    const db = await getDb();
    const cfg = await db
      .selectFrom("chain_config")
      .select(["chain_name", "currency"])
      .where("id", "=", "default")
      .executeTakeFirst();
    const branchRow = await db
      .selectFrom("branches")
      .select("name")
      .limit(1)
      .executeTakeFirst();

    const receipt: ReceiptData = {
      chainName: cfg?.chain_name ?? "مطعمي",
      branchName: branchRow?.name ?? "الفرع الرئيسي",
      currency: cfg?.currency ?? "SAR",
      orderNumber: orderId.slice(0, 8),
      tableName: tableName ?? "",
      orderType,
      items: items.filter((i) => !i.voided).map((i) => ({
        name: i.name,
        quantity: i.quantity,
        priceCents: i.unitPriceCents,
        modifiers: i.modifiers,
        ...(i.comboId ? { comboId: i.comboId } : {}),
      })),
      subtotalCents: state.subtotal(),
      taxCents: t.taxCents,
      secondaryTaxCents: t.secondaryTaxCents,
      serviceChargeCents: t.serviceChargeCents,
      discountCents: state.discountCents,
      savingsCents: state.savingsCents,
      totalCents: state.total(),
      paymentMethod: method,
      changeCents,
      ...(orderType !== "DINE_IN" && customerName ? { customerName } : {}),
      ...(orderType !== "DINE_IN" && customerPhone ? { customerPhone } : {}),
      ...(orderType === "DELIVERY" && deliveryAddress ? { deliveryAddress } : {}),
    };

    try {
      await finalizeOrder(orderId, method, receivedCents, changeCents, receipt, debtorId);
    } catch (e) {
      console.error("finalizeOrder failed:", e);
      setReceiptData(receipt);
      setShowOnScreenReceipt(true);
      setSuccessMsg("فشلت الطباعة، تم عرض الإيصال على الشاشة");
      setTimeout(() => setSuccessMsg(null), 5000);
    }

    setShowPayment(false);
    setSuccessMsg("تمت عملية الدفع بنجاح ✓");
    setTimeout(() => setSuccessMsg(null), 3000);

    if (loyaltyCard) {
      try {
        const totalCents = useCartStore.getState().total();
        const pointsEarned = Math.floor(totalCents / 100);
        const db = await getDb();
        const cardRec = await db.selectFrom("loyalty_cards").select("id").where("card_number", "=", loyaltyCard.card_number).executeTakeFirst();
        if (cardRec) {
          await db.updateTable("loyalty_cards").set({
            points: sql`points + ${pointsEarned}`,
            last_used_at: new Date().toISOString(),
          }).where("id", "=", cardRec.id).execute();
          await db.insertInto("loyalty_transactions").values({
            id: crypto.randomUUID(),
            card_id: cardRec.id,
            points: pointsEarned,
            type: "EARN",
            reference_type: "ORDER",
            reference_id: orderId,
            description: `نقاط مكتسبة من طلبية ${orderId.slice(0, 8)}`,
            created_at: new Date().toISOString(),
          }).execute();
        }
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

    const newOrderIds = await splitBill(
      orderId,
      splits.map((s) => ({
        itemIds: s.itemIds,
        amountCents: s.amountCents,
        label: s.label,
      })),
      user.id,
      tableId
    );

    setShowSplit(false);
    setSuccessMsg(`تم تقسيم الفاتورة إلى ${newOrderIds.length} فواتير ✓`);
    setTimeout(() => setSuccessMsg(null), 3000);
    clearCart();
    fetchTables();
  };

  const handleMergeConfirm = async (sourceIds: string[], targetId: string) => {
    if (!user) return;
    const orderId = await mergeTables(sourceIds, targetId, user.id);
    setShowMerge(false);
    if (orderId) {
      setSuccessMsg("تم دمج الطاولات ✓");
      setTimeout(() => setSuccessMsg(null), 3000);
    }
    fetchTables();
  };

  const handleVoidConfirm = (reason: string) => {
    if (!voidTargetItem) return;
    const item = items.find((i) => i.id === voidTargetItem);
    if (item) {
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

  return (
    <div className="flex flex-col h-full" dir="rtl">
      <div className="flex flex-1 overflow-hidden">
        <LeftPanel
          onVoidItem={(itemId, name, price) => {
            setVoidTargetItem(itemId);
            setVoidTargetName(name);
            setVoidTargetPrice(price);
            setShowVoid(true);
          }}
          onTransfer={() => setShowTransfer(true)}
        />
        <div className="flex-1 flex flex-col overflow-hidden">
          {orderType !== "DINE_IN" && (
            <div className="h-14 shrink-0 bg-white border-b border-slate-200 flex items-center gap-3 px-4 text-sm">
              <div className="flex items-center gap-1.5 text-slate-400">
                <User className="w-4 h-4" />
              </div>
              <input
                value={customerName}
                onChange={(e) => useOrderTypeStore.getState().setCustomerName(e.target.value)}
                placeholder="اسم العميل"
                className="h-8 px-2 border border-slate-200 rounded text-sm w-40 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400"
              />
              <input
                value={customerPhone}
                onChange={(e) => useOrderTypeStore.getState().setCustomerPhone(e.target.value)}
                placeholder="رقم الجوال"
                className="h-8 px-2 border border-slate-200 rounded text-sm w-36 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400"
                dir="ltr"
              />
              <button
                onClick={() => setShowLoyaltyScan(true)}
                className={`flex items-center gap-1.5 h-8 px-3 rounded text-sm font-medium transition-colors ${
                  loyaltyCard
                    ? "bg-purple-100 text-purple-700 border border-purple-300"
                    : "bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200"
                }`}
                title="ربط بطاقة ولاء"
              >
                <Award className="w-3.5 h-3.5" />
                {loyaltyCard ? `${loyaltyCard.customer_name} (${loyaltyCard.points}ن)` : "ولاء"}
              </button>
              {orderType === "DELIVERY" && (
                <>
                  <input
                    value={deliveryAddress}
                    onChange={(e) => useOrderTypeStore.getState().setDeliveryAddress(e.target.value)}
                    placeholder="عنوان التوصيل"
                    className="h-8 px-2 border border-slate-200 rounded text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400"
                  />
                  <button
                    onClick={() => setShowDriverSelect(true)}
                    className={`flex items-center gap-1.5 h-8 px-3 rounded text-sm font-medium transition-colors ${
                      driverId
                        ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                        : "bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200"
                    }`}
                  >
                    <Truck className="w-3.5 h-3.5" />
                    {driverId ? "سائق تم اختياره" : "اختيار سائق"}
                  </button>
                </>
              )}
            </div>
          )}
          <div className="flex-1 overflow-hidden">
            <MenuGrid />
          </div>
          <CategoryDock />
        </div>
        <RightPanel
          onSplit={() => setShowSplit(true)}
          onOrderType={() => setShowOrderType(true)}
        />
      </div>

      <TableBar
        tables={tables}
        selectedId={tableId}
        onSelect={(t) => {
          if (t.status === "FREE" || t.status === "OCCUPIED") {
            handleTableSelect(t);
          }
        }}
        onMerge={() => setShowMerge(true)}
      />

      {showOrderType && (
        <OrderTypeSelector
          onSelect={(type) => {
            setOrderType(type);
            setShowOrderType(false);
          }}
          onClose={() => setShowOrderType(false)}
        />
      )}

      {showLoyaltyScan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold text-slate-900 font-arabic">ربط بطاقة ولاء</h2>
            <p className="text-sm text-slate-500 font-arabic">أدخل رقم بطاقة الولاء أو امسحها ضوئياً</p>
            <input
              type="text"
              id="loyalty-scan-input"
              placeholder="رقم البطاقة"
              className="w-full h-10 px-4 rounded-xl border border-slate-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
              dir="ltr"
              autoFocus
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (!val) return;
                  try {
                    const db = await getDb();
                    const card = await db
                      .selectFrom("loyalty_cards")
                      .innerJoin("customers", "customers.id", "loyalty_cards.customer_id")
                      .select([
                        "loyalty_cards.card_number",
                        "loyalty_cards.points",
                        "loyalty_cards.tier",
                        "customers.name as customer_name",
                      ])
                      .where("loyalty_cards.card_number", "=", val)
                      .where("loyalty_cards.is_active", "=", 1)
                      .executeTakeFirst();
                    if (card) {
                      setLoyaltyCard(card);
                      useOrderTypeStore.getState().setCustomerName(card.customer_name);
                      setShowLoyaltyScan(false);
                    } else {
                      alert("بطاقة ولاء غير صالحة");
                    }
                  } catch {
                    alert("حدث خطأ في البحث عن البطاقة");
                  }
                }
              }}
            />
            <div className="text-xs text-slate-400 font-arabic text-center">امسح QRコード أو أدخل الرقم واضغط Enter</div>
            <div className="flex justify-center">
              <button onClick={() => setShowLoyaltyScan(false)} className="px-6 h-10 rounded-xl border border-slate-200 text-slate-500 text-sm font-bold hover:bg-white transition-colors">إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {showDriverSelect && (
        <DriverSelectModal
          selectedId={driverId}
          onSelect={(id) => {
            setDriverId(id);
            setShowDriverSelect(false);
          }}
          onClose={() => setShowDriverSelect(false)}
        />
      )}

      {showPayment && (
        <PaymentModal
          onClose={() => setShowPayment(false)}
          onSuccess={handlePaymentSuccess}
        />
      )}

      {showPin && (
        <ManagerPinModal
          title="تصريح المدير"
          description={
            pinAction === "discount"
              ? "نسبة الخصم تتجاوز الحد المسموح. يرجى إدخال كلمة مرور المدير."
              : "يرجى إدخال كلمة مرور المدير للمتابعة."
          }
          onSuccess={() => {
            setShowPin(false);
            if (pinAction === "discount") {
              setShowPayment(true);
            }
          }}
          onCancel={() => setShowPin(false)}
        />
      )}

      {showSplit && (
        <SplitBillModal
          onClose={() => setShowSplit(false)}
          onConfirm={handleSplitConfirm}
        />
      )}

      {showMerge && (
        <MergeTablesModal
          tables={tables}
          selectedTableId={tableId}
          onMerge={handleMergeConfirm}
          onCancel={() => setShowMerge(false)}
        />
      )}

      {showVoid && (
        <VoidItemModal
          itemName={voidTargetName}
          itemPriceCents={voidTargetPrice}
          onConfirm={handleVoidConfirm}
          onCancel={() => {
            setShowVoid(false);
            setVoidTargetItem(null);
          }}
        />
      )}

      {showTransfer && (
        <TransferOrderModal
          currentTable={tableId ? { id: tableId, name: tableName ?? "" } : null}
          tables={tables}
          onTransfer={handleTransferConfirm}
          onCancel={() => setShowTransfer(false)}
        />
      )}

      {showOnScreenReceipt && (
        <OnScreenReceiptModal
          receiptData={receiptData}
          onClose={() => setShowOnScreenReceipt(false)}
        />
      )}

      {successMsg && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-emerald-600 text-white px-6 py-3 rounded-xl shadow-lg z-50 font-arabic">
          {successMsg}
        </div>
      )}
      {dbError && (
        <div className="fixed top-32 left-1/2 -translate-x-1/2 bg-amber-500 text-white px-6 py-3 rounded-xl shadow-lg z-50 font-arabic">
          {dbError}
        </div>
      )}
    </div>
  );
}
