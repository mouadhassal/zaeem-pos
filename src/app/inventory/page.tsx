import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../../db";
import { sql } from "kysely";
import { z } from "zod";
import { useAuthStore } from "../../stores/authStore";
import { Package, Search, Edit3, ChevronDown, ChevronUp } from "lucide-react";
import EmptyState from "../../components/ui/EmptyState";

const editSchema = z.object({
  name: z.string().min(1, "الاسم مطلوب"),
  unit: z.string().min(1, "الوحدة مطلوبة"),
  cost_cents_per_unit: z.number().int().min(0, "يجب أن تكون القيمة 0 أو أكثر"),
  min_stock: z.number().min(0, "يجب أن تكون القيمة 0 أو أكثر"),
});

const supplierSchema = z.object({
  name: z.string().min(1, "الاسم مطلوب"),
  phone: z.string().optional(),
  email: z.string().email("بريد غير صالح").optional().or(z.literal("")),
  address: z.string().optional(),
  notes: z.string().optional(),
});

interface Ingredient {
  id: string;
  name: string;
  unit: string;
  cost_cents_per_unit: number;
  current_stock: number;
  min_stock: number;
  is_active: number;
  sync_version: number;
  last_modified: string;
  sync_status: string;
}

interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  total_orders: number;
  total_purchases_cents: number;
}

interface InventoryLog {
  id: string;
  ingredient_id: string;
  change_amount: number;
  reason: string;
  user_id: string;
  created_at: string;
  ingredient_name: string;
  user_name: string;
}

function getTypeLabel(change_amount: number, reason: string): string {
  if (change_amount > 0) return "إضافة";
  const lower = reason.toLowerCase();
  if (lower.includes("هالك") || lower.includes("تالف")) return "هالك";
  if (lower.includes("بيع")) return "بيع";
  return "خصم";
}

function getTypeKey(change_amount: number, reason: string): string {
  if (change_amount > 0) return "add";
  const lower = reason.toLowerCase();
  if (lower.includes("هالك") || lower.includes("تالف")) return "waste";
  if (lower.includes("بيع")) return "sale";
  return "remove";
}

function StockBadge({ qty, min }: { qty: number; min: number }) {
  if (qty <= 0) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-50 text-red-600 text-xs font-medium">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        نفذت
      </span>
    );
  }
  if (qty <= min) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 text-amber-600 text-xs font-medium">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        منخفض
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-saffron-50 text-saffron-600 text-xs font-medium">
      <span className="w-1.5 h-1.5 rounded-full bg-saffron-600" />
      {qty}
    </span>
  );
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("ar-SA", {
    style: "currency",
    currency: "SAR",
  }).format(cents / 100);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ar-SA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4" dir="rtl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink-900">{title}</h2>
          <button
            onClick={onClose}
            className="text-ink-500 hover:text-ink-500 text-xl leading-none"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface PurchaseOrder {
  id: string;
  supplier_id: string;
  branch_id: string | null;
  status: string;
  total_cents: number;
  notes: string | null;
  created_by: string;
  created_at: string;
  received_at: string | null;
  supplier_name: string;
  creator_name: string;
  items?: PurchaseOrderItem[];
}

interface PurchaseOrderItem {
  id: string;
  purchase_order_id: string;
  ingredient_id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost_cents: number;
  ingredient_name: string;
}

type TabKey = "stock" | "suppliers" | "movements" | "alerts" | "purchases";

export default function InventoryPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("stock");
  const [showAddIngredient, setShowAddIngredient] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const tabs: { key: TabKey; label: string }[] = [
    { key: "stock", label: "المخزون" },
    { key: "suppliers", label: "الموردون" },
    { key: "movements", label: "حركات المخزون" },
    { key: "alerts", label: "تنبيهات" },
    { key: "purchases", label: "طلبيات الشراء" },
  ];

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">إدارة المخزون</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowAddIngredient(true)} className="h-10 px-5 rounded-lg bg-saffron-600 text-white text-sm font-medium shadow-sm shadow-200 hover:bg-saffron-700 hover:shadow-md hover:shadow-200 active:scale-[0.98] transition-all duration-150">
            + إضافة مادة
          </button>
          <AddIngredientModal
            open={showAddIngredient}
            onClose={() => setShowAddIngredient(false)}
            onSaved={() => { setShowAddIngredient(false); setRefreshKey((k) => k + 1); }}
          />
          <button className="h-10 px-5 rounded-lg bg-white text-ink-900 text-sm font-medium border border-ink-200 hover:bg-white hover:border-ink-300 active:scale-[0.98] transition-all duration-150">
            جرد المخزون
          </button>
          <button className="h-10 px-4 rounded-lg text-ink-400 text-sm hover:bg-white hover:text-ink-900 active:scale-[0.98] transition-all duration-150">
            تقرير الهالك
          </button>
        </div>
      </div>

      <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "stock" && <StockTab refreshKey={refreshKey} />}
      {activeTab === "suppliers" && <SuppliersTab />}
      {activeTab === "alerts" && <AlertsTab />}
      {activeTab === "movements" && <MovementsTab />}
      {activeTab === "purchases" && <PurchasesTab />}
    </div>
  );
}

function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: TabKey; label: string }[];
  active: TabKey;
  onChange: (k: TabKey) => void;
}) {
  return (
    <div className="flex gap-1 bg-white rounded-xl p-1 w-fit">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`px-5 py-2 rounded-lg text-sm font-bold transition-colors ${
            active === t.key
              ? "bg-white text-saffron-600 shadow-sm"
              : "text-ink-400 hover:text-ink-900"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ============= TAB 1: المخزون ============= */

function StockTab({ refreshKey }: { refreshKey: number }) {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [filtered, setFiltered] = useState<Ingredient[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const [addTarget, setAddTarget] = useState<Ingredient | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Ingredient | null>(null);
  const [editTarget, setEditTarget] = useState<Ingredient | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const token = useAuthStore.getState().token;
      const rows = await invoke<Ingredient[]>("list_ingredients_v3", { sessionToken: token });
      setIngredients(rows);
      setFiltered(rows);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, [refreshKey]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  useEffect(() => {
    if (!search.trim()) {
      setFiltered(ingredients);
    } else {
      const q = search.trim().toLowerCase();
      setFiltered(
        ingredients.filter((i) => i.name.toLowerCase().includes(q))
      );
    }
  }, [search, ingredients]);

  const handleAddRemove = async (
    ingredient: Ingredient,
    change: number,
    reason: string
  ) => {
    try {
      const token = useAuthStore.getState().token;
      await invoke("adjust_stock_v3", { sessionToken: token, ingredientId: ingredient.id, changeAmount: change, reason });
      await fetch();
    } catch {
      // handled
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-ink-500 font-arabic">
        جاري التحميل...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="بحث..."
          className="w-full h-10 pr-10 pl-4 rounded-lg bg-white border border-ink-200 text-sm text-right focus:bg-white focus:border-saffron-300 focus:ring-2 focus:ring-saffron-100 transition-all outline-none"
        />
      </div>

      <div className="bg-white rounded-xl border border-ink-200 shadow-sm overflow-hidden">
        <div className="grid grid-cols-7 gap-4 px-6 py-3 bg-white/80 border-b border-ink-200">
          <div className="text-xs font-semibold text-ink-400">المادة</div>
          <div className="text-xs font-semibold text-ink-400">الوحدة</div>
          <div className="text-xs font-semibold text-ink-400 text-center">الكمية الحالية</div>
          <div className="text-xs font-semibold text-ink-400 text-center">الحد الأدنى</div>
          <div className="text-xs font-semibold text-ink-400 text-center">الكمية المطلوبة</div>
          <div className="text-xs font-semibold text-ink-400 text-center">آخر تحديث</div>
          <div className="text-xs font-semibold text-ink-400 text-left">إجراءات</div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={<Package className="w-8 h-8 text-ink-400" />}
            title="لا توجد مواد في المخزون"
            description="ابدأ بإضافة أول مادة لتتبع المخزون بشكل فعال"
          />
        ) : (
          filtered.map((ing, i) => {
            const required = Math.max(0, ing.min_stock * 2 - ing.current_stock);
            return (
              <div
                key={ing.id}
                className={`grid grid-cols-7 gap-4 px-6 py-4 items-center transition-colors ${
                  i !== filtered.length - 1 ? "border-b border-ink-50" : ""
                } hover:bg-ink-50`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center">
                    <Package className="w-4 h-4 text-ink-500" />
                  </div>
                  <span className="text-sm font-medium text-ink-900">{ing.name}</span>
                </div>

                <div className="text-sm text-ink-400">{ing.unit}</div>

                <div className="text-center">
                  <StockBadge qty={ing.current_stock} min={ing.min_stock} />
                </div>

                <div className="text-center text-sm text-ink-400">{ing.min_stock}</div>

                <div className="text-center text-sm text-ink-400">
                  {required > 0 ? required : "—"}
                </div>

                <div className="text-center text-xs text-ink-500">
                  {formatDate(ing.last_modified)}
                </div>

                <div className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => setAddTarget(ing)}
                    className="p-2 rounded-lg text-ink-500 hover:text-saffron-600 hover:bg-saffron-50 transition-colors"
                    title="إضافة كمية"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setRemoveTarget(ing)}
                    className="p-2 rounded-lg text-ink-500 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="خصم كمية"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setEditTarget(ing)}
                    className="p-2 rounded-lg text-ink-500 hover:text-blue-500 hover:bg-blue-50 transition-colors"
                    title="تعديل"
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <AddStockModal
        target={addTarget}
        onClose={() => setAddTarget(null)}
        onSave={(ing, qty, reason) => handleAddRemove(ing, qty, reason)}
      />
      <RemoveStockModal
        target={removeTarget}
        onClose={() => setRemoveTarget(null)}
        onSave={(ing, qty, reason) => handleAddRemove(ing, -qty, reason)}
      />
      <EditIngredientModal
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={fetch}
      />

    </div>
  );
}

function AddStockModal({
  target,
  onClose,
  onSave,
}: {
  target: Ingredient | null;
  onClose: () => void;
  onSave: (ing: Ingredient, qty: number, reason: string) => void;
}) {
  const [qty, setQty] = useState(0);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  if (!target) return null;

  const handleSubmit = () => {
    if (qty <= 0) return;
    if (!reason.trim()) return;
    const fullReason = notes.trim()
      ? `${reason.trim()} (${notes.trim()})`
      : reason.trim();
    onSave(target, qty, fullReason);
    setQty(0);
    setReason("");
    setNotes("");
    onClose();
  };

  return (
    <Modal open={!!target} onClose={onClose} title="إضافة كمية">
      <div className="space-y-3">
        <p className="text-sm text-ink-900">
          المادة: <span className="font-bold">{target.name}</span>
        </p>
        <input
          type="number"
          value={qty || ""}
          onChange={(e) => setQty(Number(e.target.value))}
          placeholder="الكمية"
          className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
        />
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="السبب (مطلوب)"
          className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
        />
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="ملاحظات (اختياري)"
          className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
        />
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSubmit}
            disabled={qty <= 0 || !reason.trim()}
            className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-40"
          >
            تأكيد
          </button>
          <button
            onClick={onClose}
            className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors"
          >
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RemoveStockModal({
  target,
  onClose,
  onSave,
}: {
  target: Ingredient | null;
  onClose: () => void;
  onSave: (ing: Ingredient, qty: number, reason: string) => void;
}) {
  const [qty, setQty] = useState(0);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  if (!target) return null;

  const handleSubmit = () => {
    if (qty <= 0) return;
    if (!reason.trim()) return;
    if (qty > target.current_stock) return;
    const fullReason = notes.trim()
      ? `${reason.trim()} (${notes.trim()})`
      : reason.trim();
    onSave(target, qty, fullReason);
    setQty(0);
    setReason("");
    setNotes("");
    onClose();
  };

  return (
    <Modal open={!!target} onClose={onClose} title="خصم كمية">
      <div className="space-y-3">
        <p className="text-sm text-ink-900">
          المادة: <span className="font-bold">{target.name}</span>
          <span className="mr-2 text-ink-500 text-xs font-mono">
            (المخزون: {target.current_stock})
          </span>
        </p>
        <input
          type="number"
          value={qty || ""}
          onChange={(e) => setQty(Number(e.target.value))}
          placeholder="الكمية"
          max={target.current_stock}
          className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
        />
        {qty > target.current_stock && (
          <p className="text-red-500 text-xs">الكمية تتجاوز المخزون المتاح</p>
        )}
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="السبب (مطلوب)"
          className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
        />
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="ملاحظات (اختياري)"
          className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
        />
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSubmit}
            disabled={qty <= 0 || !reason.trim() || qty > target.current_stock}
            className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-40"
          >
            تأكيد
          </button>
          <button
            onClick={onClose}
            className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors"
          >
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AddIngredientModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [cost, setCost] = useState(0);
  const [minStock, setMinStock] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setName(""); setUnit(""); setCost(0); setMinStock(0); setErrors({}); }
  }, [open]);

  const handleSubmit = async () => {
    const parsed = editSchema.safeParse({ name: name.trim(), unit: unit.trim(), cost_cents_per_unit: cost, min_stock: minStock });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) { fieldErrors[issue.path[0] as string] = issue.message; }
      setErrors(fieldErrors);
      return;
    }
    setSaving(true);
    try {
      const token = useAuthStore.getState().token;
      await invoke("create_ingredient_v3", {
        sessionToken: token,
        name: parsed.data.name,
        unit: parsed.data.unit,
        costCentsPerUnit: parsed.data.cost_cents_per_unit,
        minStock: parsed.data.min_stock,
      });
      onSaved();
    } catch { setErrors({ _form: "حدث خطأ في الحفظ" }); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="إضافة مادة جديدة">
      <div className="space-y-3">
        <div>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم المادة" className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500" />
          {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name}</p>}
        </div>
        <div>
          <input type="text" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="الوحدة (كجم, لتر, قطعة...)" className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500" />
          {errors.unit && <p className="text-red-500 text-xs mt-1">{errors.unit}</p>}
        </div>
        <div>
          <input type="number" value={cost || ""} onChange={(e) => setCost(Number(e.target.value))} placeholder="التكلفة لكل وحدة (هللة)" className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500" />
          {errors.cost_cents_per_unit && <p className="text-red-500 text-xs mt-1">{errors.cost_cents_per_unit}</p>}
        </div>
        <div>
          <input type="number" value={minStock || ""} onChange={(e) => setMinStock(Number(e.target.value))} placeholder="الحد الأدنى للمخزون" className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500" />
          {errors.min_stock && <p className="text-red-500 text-xs mt-1">{errors.min_stock}</p>}
        </div>
        {errors._form && <p className="text-sm text-red-500">{errors._form}</p>}
        <div className="flex gap-2 pt-2">
          <button onClick={handleSubmit} disabled={saving} className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-40">{saving ? "جاري..." : "إضافة"}</button>
          <button onClick={onClose} className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">إلغاء</button>
        </div>
      </div>
    </Modal>
  );
}

function EditIngredientModal({
  target,
  onClose,
  onSaved,
}: {
  target: Ingredient | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [cost, setCost] = useState(0);
  const [minStock, setMinStock] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (target) {
      setName(target.name);
      setUnit(target.unit);
      setCost(target.cost_cents_per_unit);
      setMinStock(target.min_stock);
      setErrors({});
    }
  }, [target]);

  if (!target) return null;

  const handleSubmit = async () => {
    const parsed = editSchema.safeParse({
      name: name.trim(),
      unit: unit.trim(),
      cost_cents_per_unit: cost,
      min_stock: minStock,
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as string;
        fieldErrors[field] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    try {
      const token = useAuthStore.getState().token;
      await invoke("update_ingredient_v3", {
        sessionToken: token,
        ingredientId: target.id,
        name: parsed.data.name,
        unit: parsed.data.unit,
        costCentsPerUnit: parsed.data.cost_cents_per_unit,
        minStock: parsed.data.min_stock,
      });
      onSaved();
      onClose();
    } catch {
      // handled
    }
  };

  return (
    <Modal open={!!target} onClose={onClose} title="تعديل المادة">
      <div className="space-y-3">
        <div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="اسم المادة"
            className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
          />
          {errors.name && (
            <p className="text-red-500 text-xs mt-1">{errors.name}</p>
          )}
        </div>
        <div>
          <input
            type="text"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="الوحدة (كجم, لتر, قطعة...)"
            className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
          />
          {errors.unit && (
            <p className="text-red-500 text-xs mt-1">{errors.unit}</p>
          )}
        </div>
        <div>
          <input
            type="number"
            value={cost || ""}
            onChange={(e) => setCost(Number(e.target.value))}
            placeholder="التكلفة لكل وحدة (هللة)"
            className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
          />
          {errors.cost_cents_per_unit && (
            <p className="text-red-500 text-xs mt-1">
              {errors.cost_cents_per_unit}
            </p>
          )}
        </div>
        <div>
          <input
            type="number"
            value={minStock || ""}
            onChange={(e) => setMinStock(Number(e.target.value))}
            placeholder="الحد الأدنى للمخزون"
            className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
          />
          {errors.min_stock && (
            <p className="text-red-500 text-xs mt-1">{errors.min_stock}</p>
          )}
        </div>
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSubmit}
            className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
          >
            حفظ
          </button>
          <button
            onClick={onClose}
            className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors"
          >
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ============= TAB 2: الموردون ============= */

function SuppliersTab() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<Supplier | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showOrder, setShowOrder] = useState<Supplier | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const db = await getDb();
      const rows = await db
        .selectFrom("suppliers")
        .selectAll()
        .orderBy("name", "asc")
        .execute();
      setSuppliers(rows);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const handleDelete = async (id: string) => {
    try {
      const db = await getDb();
      await db.deleteFrom("suppliers").where("id", "=", id).execute();
      await fetch();
    } catch {
      // handled
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-ink-500 font-arabic">
        جاري التحميل...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        onClick={() => setShowAdd(true)}
        className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
      >
        + إضافة مورد
      </button>

      <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-ink-400 font-arabic">
              <th className="text-right p-3">اسم المورد</th>
              <th className="text-right p-3">الهاتف</th>
              <th className="text-right p-3">البريد</th>
              <th className="text-right p-3">عدد الطلبيات</th>
              <th className="text-right p-3">إجمالي المشتريات</th>
              <th className="text-right p-3">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr
                key={s.id}
                className="border-b border-ink-200 hover:bg-white transition-colors"
              >
                <td className="p-3 font-medium text-ink-900">{s.name}</td>
                <td className="p-3 text-ink-400 font-mono" dir="ltr">
                  {s.phone || "—"}
                </td>
                <td className="p-3 text-ink-400">{s.email || "—"}</td>
                <td className="p-3 font-mono text-ink-900">
                  {s.total_orders}
                </td>
                <td className="p-3 font-mono text-ink-900">
                  {formatCurrency(s.total_purchases_cents)}
                </td>
                <td className="p-3">
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowOrder(s)}
                      className="px-3 py-1.5 rounded-lg bg-indigo-100 text-indigo-700 text-xs font-bold hover:bg-indigo-200 transition-colors"
                      title="طلبية جديدة"
                    >
                      📋
                    </button>
                    <button
                      onClick={() => setEditTarget(s)}
                      className="px-3 py-1.5 rounded-lg bg-blue-100 text-blue-700 text-xs font-bold hover:bg-blue-200 transition-colors"
                      title="تعديل"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => handleDelete(s.id)}
                      className="px-3 py-1.5 rounded-lg bg-red-100 text-red-700 text-xs font-bold hover:bg-red-200 transition-colors"
                      title="حذف"
                    >
                      🗑️
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {suppliers.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center p-6 text-ink-500 font-arabic">
                  لا يوجد موردون
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <SupplierModal
        target={editTarget}
        open={showAdd || !!editTarget}
        onClose={() => {
          setShowAdd(false);
          setEditTarget(null);
        }}
        onSaved={fetch}
      />
      <NewOrderModal
        supplier={showOrder}
        onClose={() => setShowOrder(null)}
        onSaved={fetch}
      />
    </div>
  );
}

function SupplierModal({
  target,
  open,
  onClose,
  onSaved,
}: {
  target: Supplier | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!target;
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      if (target) {
        setName(target.name);
        setPhone(target.phone ?? "");
        setEmail(target.email ?? "");
        setAddress(target.address ?? "");
        setNotes(target.notes ?? "");
      } else {
        setName("");
        setPhone("");
        setEmail("");
        setAddress("");
        setNotes("");
      }
      setErrors({});
    }
  }, [open, target]);

  const handleSubmit = async () => {
    const parsed = supplierSchema.safeParse({
      name: name.trim(),
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      address: address.trim() || undefined,
      notes: notes.trim() || undefined,
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as string;
        fieldErrors[field] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    try {
      const db = await getDb();
      if (isEdit) {
        await db
          .updateTable("suppliers")
          .set({
            name: parsed.data.name,
            phone: parsed.data.phone ?? null,
            email: parsed.data.email ?? null,
            address: parsed.data.address ?? null,
            notes: parsed.data.notes ?? null,
          })
          .where("id", "=", target.id)
          .execute();
      } else {
        await db
          .insertInto("suppliers")
          .values({
            id: crypto.randomUUID(),
            name: parsed.data.name,
            phone: parsed.data.phone ?? null,
            email: parsed.data.email ?? null,
            address: parsed.data.address ?? null,
            notes: parsed.data.notes ?? null,
            total_orders: 0,
            total_purchases_cents: 0,
          })
          .execute();
      }
      onSaved();
      onClose();
    } catch {
      // handled
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? "تعديل المورد" : "إضافة مورد"}>
      <div className="space-y-3">
        <div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="اسم المورد"
            className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
          />
          {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name}</p>}
        </div>
        <input
          type="text"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="رقم الهاتف"
          className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
        />
        <div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="البريد الإلكتروني"
            className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
          />
          {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email}</p>}
        </div>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="العنوان"
          className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
        />
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="ملاحظات"
          className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
        />
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSubmit}
            className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
          >
            {isEdit ? "حفظ" : "إضافة"}
          </button>
          <button
            onClick={onClose}
            className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors"
          >
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NewOrderModal({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: Supplier | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const user = useAuthStore((s) => s.user);

  if (!supplier) return null;

  const handleCreate = async () => {
    try {
      const db = await getDb();
      await db
        .insertInto("purchase_orders")
        .values({
          id: crypto.randomUUID(),
          supplier_id: supplier.id,
          status: "PENDING",
          total_cents: 0,
          created_by: user?.id ?? "unknown",
          created_at: new Date().toISOString(),
        })
        .execute();
      await db
        .updateTable("suppliers")
        .set({
          total_orders: supplier.total_orders + 1,
        })
        .where("id", "=", supplier.id)
        .execute();
      onSaved();
      onClose();
    } catch {
      // handled
    }
  };

  return (
    <Modal open={!!supplier} onClose={onClose} title="طلبية جديدة">
      <p className="text-sm text-ink-900">
        إنشاء طلبية شراء للمورد: <span className="font-bold">{supplier.name}</span>
      </p>
      <p className="text-xs text-ink-500">
        سيتم إنشاء طلبية بحالة "قيد الانتظار"
      </p>
      <div className="flex gap-2 pt-2">
        <button
          onClick={handleCreate}
          className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
        >
          إنشاء
        </button>
        <button
          onClick={onClose}
          className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors"
        >
          إلغاء
        </button>
      </div>
    </Modal>
  );
}

/* ============= TAB 5: طلبيات الشراء ============= */

function PurchasesTab() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrder | null>(null);
  const [detailTarget, setDetailTarget] = useState<PurchaseOrder | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const db = await getDb();
      const rows = await db
        .selectFrom("purchase_orders")
        .innerJoin("suppliers", "suppliers.id", "purchase_orders.supplier_id")
        .innerJoin("staff", "staff.id", "purchase_orders.created_by")
        .select([
          "purchase_orders.id",
          "purchase_orders.supplier_id",
          "purchase_orders.branch_id",
          "purchase_orders.status",
          "purchase_orders.total_cents",
          "purchase_orders.notes",
          "purchase_orders.created_by",
          "purchase_orders.created_at",
          "purchase_orders.received_at",
          "suppliers.name as supplier_name",
          "staff.name as creator_name",
        ])
        .orderBy("purchase_orders.created_at", "desc")
        .execute();
      setOrders(rows);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const handleCancel = async (id: string) => {
    try {
      const db = await getDb();
      await db.updateTable("purchase_orders").set({ status: "CANCELLED" }).where("id", "=", id).execute();
      setCancelTarget(null);
      await fetch();
    } catch { /* handled */ }
  };

  const statusBadge = (s: string) => {
    if (s === "PENDING") return "bg-amber-100 text-amber-700";
    if (s === "ORDERED") return "bg-blue-100 text-blue-700";
    if (s === "RECEIVED") return "bg-saffron-100 text-saffron-600";
    if (s === "CANCELLED") return "bg-red-100 text-red-700";
    return "bg-white text-ink-500";
  };

  const statusLabel = (s: string) => {
    if (s === "PENDING") return "قيد الانتظار";
    if (s === "ORDERED") return "تم الطلب";
    if (s === "RECEIVED") return "مستلمة";
    if (s === "CANCELLED") return "ملغية";
    return s;
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-ink-500 font-arabic">جاري التحميل...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button onClick={() => setShowCreate(true)} className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors">
          + طلبية شراء جديدة
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-ink-400 font-arabic">
              <th className="text-right p-3 font-medium">رقم الطلبية</th>
              <th className="text-right p-3 font-medium">المورد</th>
              <th className="text-right p-3 font-medium">التاريخ</th>
              <th className="text-right p-3 font-medium">الإجمالي</th>
              <th className="text-right p-3 font-medium">الحالة</th>
              <th className="text-center p-3 font-medium">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((po) => (
              <tr key={po.id} className="border-b border-ink-200 hover:bg-white">
                <td className="p-3 font-mono text-ink-900 text-xs">{po.id.slice(0, 8)}</td>
                <td className="p-3 font-arabic text-ink-900 font-medium">{po.supplier_name}</td>
                <td className="p-3 font-mono text-ink-500 text-xs">{po.created_at.slice(0, 10)}</td>
                <td className="p-3 font-mono text-saffron-600 font-bold">{formatCurrency(po.total_cents)}</td>
                <td className="p-3">
                  <span className={`inline-block px-3 py-1 rounded-full text-xs font-arabic font-medium ${statusBadge(po.status)}`}>
                    {statusLabel(po.status)}
                  </span>
                </td>
                <td className="p-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <button onClick={() => setDetailTarget(po)} className="px-3 py-1.5 rounded-lg text-xs text-ink-400 hover:bg-white transition-colors" title="عرض التفاصيل">👁️</button>
                    {po.status === "PENDING" && (
                      <>
                        <button onClick={() => setReceiveTarget(po)} className="px-3 py-1.5 rounded-lg text-xs text-saffron-600 hover:bg-saffron-50 transition-colors" title="استلام">📦</button>
                        <button onClick={() => setCancelTarget(po.id)} className="px-3 py-1.5 rounded-lg text-xs text-red-500 hover:bg-red-50 transition-colors" title="إلغاء">❌</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-ink-500 font-arabic">لا توجد طلبيات شراء</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showCreate && <CreatePOModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); fetch(); }} />}
      {receiveTarget && <ReceivePOModal po={receiveTarget} onClose={() => setReceiveTarget(null)} onSaved={() => { setReceiveTarget(null); fetch(); }} />}
      {detailTarget && <PODetailModal po={detailTarget} onClose={() => setDetailTarget(null)} />}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">تأكيد الإلغاء</h2>
            <p className="text-sm text-ink-600 font-arabic">هل أنت متأكد من إلغاء طلبية الشراء هذه؟</p>
            <div className="flex gap-2 pt-2">
              <button onClick={() => handleCancel(cancelTarget)} className="flex-1 h-10 rounded-xl bg-red-600 text-white text-sm font-bold hover:bg-red-700 transition-colors">تأكيد الإلغاء</button>
              <button onClick={() => setCancelTarget(null)} className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">رجوع</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* Create PO Modal */
function CreatePOModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const user = useAuthStore((s) => s.user);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [selectedSupplier, setSelectedSupplier] = useState("");
  const [items, setItems] = useState<{ ingredient_id: string; quantity_ordered: number; unit_cost_cents: number }[]>([]);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    (async () => {
      const db = await getDb();
      const s = await db.selectFrom("suppliers").selectAll().execute();
      setSuppliers(s);
      const i = await db.selectFrom("ingredients").selectAll().where("is_active", "=", 1).execute();
      setIngredients(i);
    })();
  }, []);

  const addItem = () => {
    setItems((prev) => [...prev, { ingredient_id: "", quantity_ordered: 0, unit_cost_cents: 0 }]);
  };

  const removeItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));

  const updateItem = (idx: number, field: string, value: string | number) => {
    setItems((prev) => prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
  };

  const total = items.reduce((sum, item) => sum + item.quantity_ordered * item.unit_cost_cents, 0);

  const handleCreate = async () => {
    if (!selectedSupplier || items.length === 0) return;
    try {
      const db = await getDb();
      const poId = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.insertInto("purchase_orders").values({
        id: poId,
        supplier_id: selectedSupplier,
        status: "PENDING",
        total_cents: total,
        notes: notes || null,
        created_by: user?.id ?? "unknown",
        created_at: now,
      }).execute();
      for (const item of items) {
        await db.insertInto("purchase_order_items").values({
          id: crypto.randomUUID(),
          purchase_order_id: poId,
          ingredient_id: item.ingredient_id,
          quantity_ordered: item.quantity_ordered,
          quantity_received: 0,
          unit_cost_cents: item.unit_cost_cents,
        }).execute();
      }
      await db.updateTable("suppliers").set({ total_orders: sql`total_orders + 1` }).where("id", "=", selectedSupplier).execute();
      onSaved();
    } catch { /* handled */ }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto p-6 space-y-4">
        <h2 className="text-lg font-bold text-ink-900 font-arabic">طلبية شراء جديدة</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-arabic text-ink-900 mb-1">المورد</label>
            <select value={selectedSupplier} onChange={(e) => setSelectedSupplier(e.target.value)} className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500">
              <option value="">اختر المورد</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-arabic text-ink-900 mb-1">ملاحظات</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500" />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-arabic text-ink-900 font-bold">الأصناف</label>
              <button onClick={addItem} className="px-3 py-1.5 rounded-lg bg-indigo-100 text-indigo-700 text-xs font-bold hover:bg-indigo-200 transition-colors">+ إضافة صنف</button>
            </div>
            {items.map((item, idx) => (
              <div key={idx} className="flex gap-2 items-start">
                <select value={item.ingredient_id} onChange={(e) => updateItem(idx, "ingredient_id", e.target.value)} className="flex-1 h-10 px-3 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500">
                  <option value="">اختر المادة</option>
                  {ingredients.map((ing) => <option key={ing.id} value={ing.id}>{ing.name}</option>)}
                </select>
                <input type="number" min="0" step="0.01" value={item.quantity_ordered || ""} onChange={(e) => updateItem(idx, "quantity_ordered", Number(e.target.value))} placeholder="الكمية" className="w-24 h-10 px-3 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500" />
                <input type="number" min="0" value={item.unit_cost_cents || ""} onChange={(e) => updateItem(idx, "unit_cost_cents", Number(e.target.value))} placeholder="سعر الوحدة" className="w-28 h-10 px-3 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500" />
                <button onClick={() => removeItem(idx)} className="h-10 px-3 rounded-xl text-red-500 hover:bg-red-50 transition-colors">✕</button>
              </div>
            ))}
          </div>

          <div className="text-left">
            <span className="text-sm text-ink-500 font-arabic">الإجمالي: </span>
            <span className="text-lg font-bold text-saffron-600 font-mono">{formatCurrency(total)}</span>
          </div>

          <div className="flex gap-2 pt-2">
            <button onClick={handleCreate} disabled={!selectedSupplier || items.length === 0} className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-40">إنشاء الطلبية</button>
            <button onClick={onClose} className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">إلغاء</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Receive PO Modal */
function ReceivePOModal({ po, onClose, onSaved }: { po: PurchaseOrder; onClose: () => void; onSaved: () => void }) {
  const [items, setItems] = useState<PurchaseOrderItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const db = await getDb();
        const rows = await db
          .selectFrom("purchase_order_items")
          .innerJoin("ingredients", "ingredients.id", "purchase_order_items.ingredient_id")
          .select([
            "purchase_order_items.id",
            "purchase_order_items.purchase_order_id",
            "purchase_order_items.ingredient_id",
            "purchase_order_items.quantity_ordered",
            "purchase_order_items.quantity_received",
            "purchase_order_items.unit_cost_cents",
            "ingredients.name as ingredient_name",
          ])
          .where("purchase_order_items.purchase_order_id", "=", po.id)
          .execute();
        setItems(rows);
      } catch { /* handled */ }
      finally { setLoading(false); }
    })();
  }, [po.id]);

  const updateReceived = (idx: number, val: number) => {
    setItems((prev) => prev.map((item, i) => (i === idx ? { ...item, quantity_received: val } : item)));
  };

  const handleReceive = async () => {
    try {
      const db = await getDb();
      const now = new Date().toISOString();
      for (const item of items) {
        await db.updateTable("purchase_order_items").set({ quantity_received: item.quantity_received }).where("id", "=", item.id).execute();
        const ing = await db.selectFrom("ingredients").select("current_stock").where("id", "=", item.ingredient_id).executeTakeFirst();
        if (ing) {
          const newStock = ing.current_stock + item.quantity_received;
          await db.updateTable("ingredients").set({ current_stock: newStock }).where("id", "=", item.ingredient_id).execute();
          await db.insertInto("inventory_logs").values({
            id: crypto.randomUUID(),
            ingredient_id: item.ingredient_id,
            change_amount: item.quantity_received,
            reason: "استلام طلبية شراء",
            user_id: po.created_by,
            created_at: now,
          }).execute();
        }
      }
      await db.updateTable("purchase_orders").set({ status: "RECEIVED", received_at: now }).where("id", "=", po.id).execute();
      onSaved();
    } catch { /* handled */ }
  };

  if (loading) {
    return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl p-6">جاري التحميل...</div>
    </div>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto p-6 space-y-4">
        <h2 className="text-lg font-bold text-ink-900 font-arabic">استلام طلبية - {po.id.slice(0, 8)}</h2>
        <p className="text-sm text-ink-500 font-arabic">المورد: {po.supplier_name}</p>
        <div className="space-y-3">
          {items.map((item, idx) => (
            <div key={item.id} className="bg-white rounded-xl border border-ink-200 p-3 space-y-2">
              <div className="flex justify-between">
                <span className="font-bold text-ink-900">{item.ingredient_name}</span>
                <span className="text-sm text-ink-500">الكمية المطلوبة: {item.quantity_ordered}</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-ink-500 font-arabic">الكمية المستلمة:</label>
                <input type="number" min="0" max={item.quantity_ordered} step="0.01" value={item.quantity_received || ""} onChange={(e) => updateReceived(idx, Number(e.target.value))} className="w-24 h-10 px-3 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500" />
                <span className="text-xs text-ink-400">من أصل {item.quantity_ordered}</span>
              </div>
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <button onClick={handleReceive} className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors">تأكيد الاستلام</button>
            <button onClick={onClose} className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">إلغاء</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* PO Detail Modal */
function PODetailModal({ po, onClose }: { po: PurchaseOrder; onClose: () => void }) {
  const [items, setItems] = useState<PurchaseOrderItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const db = await getDb();
        const rows = await db
          .selectFrom("purchase_order_items")
          .innerJoin("ingredients", "ingredients.id", "purchase_order_items.ingredient_id")
          .select([
            "purchase_order_items.id",
            "purchase_order_items.purchase_order_id",
            "purchase_order_items.ingredient_id",
            "purchase_order_items.quantity_ordered",
            "purchase_order_items.quantity_received",
            "purchase_order_items.unit_cost_cents",
            "ingredients.name as ingredient_name",
          ])
          .where("purchase_order_items.purchase_order_id", "=", po.id)
          .execute();
        setItems(rows);
      } catch { /* handled */ }
      finally { setLoading(false); }
    })();
  }, [po.id]);

  const statusLabel = (s: string) => {
    if (s === "PENDING") return "قيد الانتظار";
    if (s === "ORDERED") return "تم الطلب";
    if (s === "RECEIVED") return "مستلمة";
    if (s === "CANCELLED") return "ملغية";
    return s;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink-900 font-arabic">تفاصيل الطلبية</h2>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-500 text-xl leading-none">✕</button>
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div><span className="text-ink-400 font-arabic">رقم الطلبية: </span><span className="font-mono text-ink-900">{po.id.slice(0, 8)}</span></div>
          <div><span className="text-ink-400 font-arabic">المورد: </span><span className="text-ink-900">{po.supplier_name}</span></div>
          <div><span className="text-ink-400 font-arabic">التاريخ: </span><span className="text-ink-900">{po.created_at.slice(0, 10)}</span></div>
          <div><span className="text-ink-400 font-arabic">الحالة: </span><span className="text-ink-900">{statusLabel(po.status)}</span></div>
          <div><span className="text-ink-400 font-arabic">المنشئ: </span><span className="text-ink-900">{po.creator_name}</span></div>
          {po.received_at && <div><span className="text-ink-400 font-arabic">تاريخ الاستلام: </span><span className="text-ink-900">{po.received_at.slice(0, 10)}</span></div>}
        </div>
        {po.notes && <div className="text-sm"><span className="text-ink-400 font-arabic">ملاحظات: </span><span className="text-ink-900">{po.notes}</span></div>}

        <div>
          <h3 className="font-bold text-ink-900 font-arabic mb-2">الأصناف</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-200 text-ink-400 font-arabic">
                <th className="text-right p-2 font-medium">المادة</th>
                <th className="text-right p-2 font-medium">الكمية المطلوبة</th>
                <th className="text-right p-2 font-medium">الكمية المستلمة</th>
                <th className="text-right p-2 font-medium">سعر الوحدة</th>
                <th className="text-right p-2 font-medium">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="p-4 text-center text-ink-500">جاري التحميل...</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={5} className="p-4 text-center text-ink-500">لا توجد أصناف</td></tr>
              ) : items.map((item) => (
                <tr key={item.id} className="border-b border-ink-200">
                  <td className="p-2 text-ink-900">{item.ingredient_name}</td>
                  <td className="p-2 font-mono">{item.quantity_ordered}</td>
                  <td className="p-2 font-mono">{item.quantity_received}</td>
                  <td className="p-2 font-mono">{formatCurrency(item.unit_cost_cents)}</td>
                  <td className="p-2 font-mono font-bold text-saffron-600">{formatCurrency(item.quantity_ordered * item.unit_cost_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="text-left">
          <span className="text-lg font-bold text-ink-900 font-arabic">الإجمالي: </span>
          <span className="text-lg font-bold text-saffron-600 font-mono">{formatCurrency(po.total_cents)}</span>
        </div>
      </div>
    </div>
  );
}

/* ============= TAB 3: حركات المخزون ============= */

function MovementsTab() {
  const [logs, setLogs] = useState<InventoryLog[]>([]);
  const [filteredLogs, setFilteredLogs] = useState<InventoryLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [ingredients, setIngredients] = useState<{ id: string; name: string }[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filterMaterial, setFilterMaterial] = useState("");
  const [filterType, setFilterType] = useState("all");

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const db = await getDb();
      const rows = await db
        .selectFrom("inventory_logs")
        .innerJoin("ingredients", "ingredients.id", "inventory_logs.ingredient_id")
        .innerJoin("staff", "staff.id", "inventory_logs.user_id")
        .select([
          "inventory_logs.id",
          "inventory_logs.ingredient_id",
          "inventory_logs.change_amount",
          "inventory_logs.reason",
          "inventory_logs.user_id",
          "inventory_logs.created_at",
          "ingredients.name as ingredient_name",
          "staff.name as user_name",
        ])
        .orderBy("inventory_logs.created_at", "desc")
        .execute();
      setLogs(rows);

      const ingRows = await db
        .selectFrom("ingredients")
        .select(["id", "name"])
        .orderBy("name", "asc")
        .execute();
      setIngredients(ingRows);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  useEffect(() => {
    let result = logs;
    if (dateFrom) {
      result = result.filter((l) => l.created_at >= dateFrom);
    }
    if (dateTo) {
      result = result.filter((l) => l.created_at <= dateTo + "T23:59:59");
    }
    if (filterMaterial) {
      result = result.filter((l) => l.ingredient_id === filterMaterial);
    }
    if (filterType !== "all") {
      result = result.filter((l) => getTypeKey(l.change_amount, l.reason) === filterType);
    }
    setFilteredLogs(result);
  }, [logs, dateFrom, dateTo, filterMaterial, filterType]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-ink-500 font-arabic">
        جاري التحميل...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        <div>
          <label className="block text-xs text-ink-400 mb-1 font-arabic">من</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-10 px-3 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
          />
        </div>
        <div>
          <label className="block text-xs text-ink-400 mb-1 font-arabic">إلى</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-10 px-3 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
          />
        </div>
        <div>
          <label className="block text-xs text-ink-400 mb-1 font-arabic">المادة</label>
          <select
            value={filterMaterial}
            onChange={(e) => setFilterMaterial(e.target.value)}
            className="h-10 px-3 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
          >
            <option value="">الكل</option>
            {ingredients.map((ing) => (
              <option key={ing.id} value={ing.id}>
                {ing.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-ink-400 mb-1 font-arabic">النوع</label>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="h-10 px-3 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500"
          >
            <option value="all">الكل</option>
            <option value="add">إضافة</option>
            <option value="remove">خصم</option>
            <option value="waste">هالك</option>
            <option value="sale">بيع</option>
          </select>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-ink-400 font-arabic">
              <th className="text-right p-3">التاريخ</th>
              <th className="text-right p-3">المادة</th>
              <th className="text-right p-3">النوع</th>
              <th className="text-right p-3">الكمية</th>
              <th className="text-right p-3">السبب</th>
              <th className="text-right p-3">المستخدم</th>
            </tr>
          </thead>
          <tbody>
            {filteredLogs.map((log) => {
              const typeLabel = getTypeLabel(log.change_amount, log.reason);
              const typeColors: Record<string, string> = {
                إضافة: "text-green-600 bg-green-50",
                خصم: "text-red-600 bg-red-50",
                هالك: "text-amber-600 bg-amber-50",
                بيع: "text-blue-600 bg-blue-50",
              };
              const colorClass = typeColors[typeLabel] ?? "text-ink-500 bg-white";
              return (
                <tr
                  key={log.id}
                  className="border-b border-ink-200 hover:bg-white transition-colors"
                >
                  <td className="p-3 text-ink-400 text-xs font-mono">
                    {formatDate(log.created_at)}
                  </td>
                  <td className="p-3 text-ink-900">{log.ingredient_name}</td>
                  <td className="p-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-lg text-xs font-bold ${colorClass}`}
                    >
                      {typeLabel}
                    </span>
                  </td>
                  <td
                    className={`p-3 font-mono font-bold ${
                      log.change_amount > 0 ? "text-green-600" : "text-red-600"
                    }`}
                  >
                    {log.change_amount > 0 ? "+" : ""}
                    {log.change_amount}
                  </td>
                  <td className="p-3 text-ink-400 text-xs max-w-xs truncate">
                    {log.reason}
                  </td>
                  <td className="p-3 text-ink-500">{log.user_name}</td>
                </tr>
              );
            })}
            {filteredLogs.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center p-6 text-ink-500 font-arabic">
                  لا توجد حركات
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============= TAB 4: تنبيهات ============= */

function AlertsTab() {
  const user = useAuthStore((s) => s.user);
  const [lowStock, setLowStock] = useState<Ingredient[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const db = await getDb();
      const ing = await db
        .selectFrom("ingredients")
        .selectAll()
        .where("is_active", "=", 1)
        .where("current_stock", "<", db.dynamic.ref("min_stock") as any)
        .orderBy("current_stock", "asc")
        .execute();
      setLowStock(ing);

      const sup = await db
        .selectFrom("suppliers")
        .selectAll()
        .orderBy("name", "asc")
        .execute();
      setSuppliers(sup);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const handleAutoOrder = async (ingredient: Ingredient) => {
    if (suppliers.length === 0) return;
    setCreating(ingredient.id);
    try {
      const db = await getDb();
      const preferred = suppliers[0];
      await db
        .insertInto("purchase_orders")
        .values({
          id: crypto.randomUUID(),
          supplier_id: preferred.id,
          status: "PENDING",
          total_cents: 0,
          notes: `طلبية تلقائية للمادة: ${ingredient.name}`,
          created_by: user?.id ?? "unknown",
          created_at: new Date().toISOString(),
        })
        .execute();
      await fetch();
    } catch {
      // handled
    } finally {
      setCreating(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-ink-500 font-arabic">
        جاري التحميل...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {suppliers.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700 font-arabic">
          لا يوجد موردون. يرجى إضافة مورد أولاً لاستخدام خاصية الطلبيات التلقائية.
        </div>
      )}

      {lowStock.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700 font-arabic">
          لا توجد مواد منخفضة المخزون. جميع المواد ضمن الحد الآمن.
        </div>
      )}

      {lowStock.map((ing) => (
        <div
          key={ing.id}
          className="bg-white rounded-2xl shadow-sm p-4 flex items-center justify-between"
        >
          <div className="space-y-1">
            <h3 className="font-bold text-ink-900">{ing.name}</h3>
            <p className="text-sm text-ink-400 font-arabic">
              المخزون الحالي:{" "}
              <span className="font-mono font-bold text-red-500">
                {ing.current_stock}
              </span>{" "}
              / الحد الأدنى:{" "}
              <span className="font-mono text-ink-900">{ing.min_stock}</span>{" "}
              {ing.unit}
            </p>
          </div>
          <button
            onClick={() => handleAutoOrder(ing)}
            disabled={creating === ing.id || suppliers.length === 0}
            className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-40"
          >
            {creating === ing.id ? "جاري الإنشاء..." : "طلبية تلقائية"}
          </button>
        </div>
      ))}
    </div>
  );
}
