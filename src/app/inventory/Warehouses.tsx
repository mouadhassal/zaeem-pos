// Warehouses in the inventory page: the small «المخازن» section (add / rename / hide) and the transfer
// dialog. A shop with one warehouse only sees the collapsed «المخازن» link.
import { useState } from "react";
import { IconX } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { trimNum, unitLabel } from "../../lib/inventoryUnits";
import { warehouseQty, type StockCell, type Warehouse } from "../../lib/warehouses";

const inputCls = "h-10 px-3 rounded-sm border-2 border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-600";
const primaryBtn = "h-10 px-5 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-40";
const ghostBtn = "h-10 px-5 rounded-sm border border-ink-200 text-ink-500 text-sm font-bold hover:bg-saffron-50 transition-colors";
const errBox = "bg-danger-soft border border-danger-soft rounded-sm p-3 text-sm text-danger font-arabic";

function WarehouseRow({ w, onChanged, onError }: { w: Warehouse; onChanged: () => void; onError: (m: string | null) => void }) {
  const token = useAuthStore((s) => s.token);
  const [name, setName] = useState(w.name);
  const [saving, setSaving] = useState(false);

  const save = async (active: boolean) => {
    if (saving) return;
    setSaving(true);
    onError(null);
    try {
      await invoke("save_warehouse_v3", { sessionToken: token, warehouseId: w.id, name, active });
      onChanged();
    } catch (err) {
      onError(realErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`flex items-center gap-2 ${w.active ? "" : "opacity-60"}`}>
      <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} flex-1 max-w-xs`} aria-label="اسم المخزن" />
      {w.is_default && <span className="px-2 py-0.5 rounded-full bg-saffron-50 text-saffron-600 text-[10px] font-bold">رئيسي</span>}
      {name.trim() !== w.name && (
        <button onClick={() => save(w.active)} disabled={saving} className={primaryBtn}>حفظ الاسم</button>
      )}
      {!w.is_default && (
        <button onClick={() => save(!w.active)} disabled={saving} className={ghostBtn}>{w.active ? "إخفاء" : "إظهار"}</button>
      )}
    </div>
  );
}

/** Add, rename and hide warehouses. Collapsed until opened. */
export function WarehousesSection({ all, onChanged }: { all: Warehouse[]; onChanged: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (saving || !newName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("save_warehouse_v3", { sessionToken: token, warehouseId: null, name: newName, active: true });
      toast.success("تمت إضافة المخزن ✓");
      setNewName("");
      onChanged();
    } catch (err) {
      setError(realErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <button onClick={() => setOpen((o) => !o)} className="text-sm font-bold text-ink-500 hover:text-saffron-600 transition-colors font-arabic">
        المخازن {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="zc-card p-4 space-y-3">
          {error && <div className={errBox}>{error}</div>}
          {all.map((w) => (
            <WarehouseRow key={`${w.id}:${w.name}:${w.active}`} w={w} onChanged={onChanged} onError={setError} />
          ))}
          <div className="flex items-center gap-2 pt-1">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="اسم مخزن جديد" className={`${inputCls} flex-1 max-w-xs`} />
            <button onClick={add} disabled={saving || !newName.trim()} className={primaryBtn}>إضافة مخزن</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** نقل بين المخازن: moves an amount of one ingredient from one warehouse to another. */
export function TransferDialog({
  ingredient,
  warehouses,
  cells,
  onClose,
  onDone,
}: {
  ingredient: { id: string; name: string; unit: string };
  /** the shown warehouses (two or more) */
  warehouses: Warehouse[];
  cells: StockCell[];
  onClose: () => void;
  onDone: () => void;
}) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const first = warehouses.find((w) => w.is_default) ?? warehouses[0];
  const [fromId, setFromId] = useState(first.id);
  const [toId, setToId] = useState((warehouses.find((w) => w.id !== first.id) ?? first).id);
  const [qty, setQty] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const have = warehouseQty(cells, ingredient.id, fromId);
  const q = parseFloat(qty) || 0;

  const submit = async () => {
    if (saving || q <= 0) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("transfer_stock_v3", { sessionToken: token, ingredientId: ingredient.id, fromWarehouseId: fromId, toWarehouseId: toId, quantity: q });
      toast.success("تم النقل ✓");
      onDone();
    } catch (err) {
      setError(realErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const select = (value: string, onChange: (v: string) => void, label: string) => (
    <div className="flex-1">
      <label className="block text-xs text-ink-400 mb-1 font-arabic">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} w-full font-arabic`}>
        {warehouses.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" dir="rtl">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink-900 font-arabic">نقل بين المخازن — {ingredient.name}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center text-ink-500 shrink-0" aria-label="إغلاق">
            <IconX className="w-4 h-4" />
          </button>
        </div>
        {error && <div className={errBox}>{error}</div>}
        <div className="flex gap-3">
          {select(fromId, setFromId, "من مخزن")}
          {select(toId, setToId, "إلى مخزن")}
        </div>
        <div>
          <label className="block text-xs text-ink-400 mb-1 font-arabic">الكمية ({unitLabel(ingredient.unit)})</label>
          <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} className={`${inputCls} w-full font-mono`} dir="ltr" />
          <p className="text-xs text-ink-500 mt-1 font-arabic">
            المتوفر في هذا المخزن: <span className="font-mono">{trimNum(have)}</span> {unitLabel(ingredient.unit)}
          </p>
        </div>
        {fromId === toId && <p className="text-xs text-danger font-arabic">اختر مخزنين مختلفين</p>}
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className={ghostBtn}>إلغاء</button>
          <button onClick={submit} disabled={saving || q <= 0 || fromId === toId || q > have} className={`${primaryBtn} flex-1`}>{saving ? "جاري..." : "نقل"}</button>
        </div>
      </div>
    </div>
  );
}
