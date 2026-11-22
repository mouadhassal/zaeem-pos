// Inventory tabs added 2026-11-22: الوحدات (units and packs), الإنتاج (base products made in-house),
// الهدر (waste), and the stock movement report. The numbers are worked out in src-tauri/src/inventory_ops.rs;
// this file only asks for them and shows them.
import { useCallback, useEffect, useMemo, useState } from "react";
import { IconX, IconPencil, IconTrash, IconAlertTriangle } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney } from "../../lib/money";
import { formatArabicDateTime } from "../../lib/dateLocal";
import DatePicker from "../../components/ui/DatePicker";
import EmptyState from "../../components/ui/EmptyState";
import UnitSelect from "../../components/inventory/UnitSelect";
import {
  KIND_LABEL,
  WASTE_REASONS,
  batchCost,
  choiceFactor,
  dayRangeIso,
  round3,
  trimNum,
  unitLabel,
  yieldPct,
  ymd,
  type IngredientPack,
  type UnitDef,
} from "../../lib/inventoryUnits";

export interface StockIngredient {
  id: string;
  name: string;
  unit: string;
  cost_cents_per_unit: number;
  current_stock: number;
  min_stock: number;
  is_produced?: number;
}

const inputCls = "h-10 px-3 rounded-sm border-2 border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-600";
const primaryBtn = "h-10 px-5 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-40";
const ghostBtn = "h-10 px-5 rounded-sm border border-ink-200 text-ink-500 text-sm font-bold hover:bg-saffron-50 transition-colors";
const errBox = "bg-danger-soft border border-danger-soft rounded-sm p-3 text-sm text-danger font-arabic";
const thCls = "text-xs font-semibold text-ink-400";

function fmtWhen(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T"));
  return formatArabicDateTime(d, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" dir="rtl">
      <div className={`bg-white rounded-2xl shadow-xl w-full ${wide ? "max-w-2xl" : "max-w-lg"} mx-4 max-h-[90vh] overflow-y-auto p-6 space-y-4`}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink-900 font-arabic">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center text-ink-500 shrink-0" aria-label="إغلاق">
            <IconX className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Ingredients and packs, loaded once and reloadable. */
function useInventoryData(refreshKey = 0) {
  const token = useAuthStore((s) => s.token);
  const [ingredients, setIngredients] = useState<StockIngredient[]>([]);
  const [packs, setPacks] = useState<IngredientPack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      const [ing, pk] = await Promise.all([
        invoke<StockIngredient[]>("list_ingredients_v3", { sessionToken: token }),
        invoke<IngredientPack[]>("list_ingredient_units_v3", { sessionToken: token }),
      ]);
      setIngredients(ing);
      setPacks(pk);
      setError(null);
    } catch (err) {
      setError(`حدث خطأ في تحميل البيانات: ${realErrorText(err)}`);
    } finally {
      setLoading(false);
    }
  }, [token]);
  useEffect(() => {
    reload();
  }, [reload, refreshKey]);
  return { ingredients, packs, error, loading, reload };
}

function packsOf(packs: IngredientPack[], ingredientId: string) {
  return packs.filter((p) => p.ingredient_id === ingredientId);
}

/* ============================ الوحدات ============================ */

export function UnitsTab() {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const { ingredients, packs, error, loading, reload } = useInventoryData();
  const [units, setUnits] = useState<UnitDef[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [ingredientId, setIngredientId] = useState("");
  const [name, setName] = useState("");
  const [factor, setFactor] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke<UnitDef[]>("list_units_v3", { sessionToken: token }).then(setUnits).catch(() => setUnits([]));
  }, [token]);

  const ing = ingredients.find((i) => i.id === ingredientId);
  const baseName = (kind: string) => (kind === "MASS" ? "غرام" : kind === "VOLUME" ? "مل" : "حبة");

  const reset = () => {
    setEditId(null);
    setName("");
    setFactor("");
    setFormError(null);
  };

  const save = async () => {
    if (!ing || saving) return;
    const f = parseFloat(factor);
    if (!name.trim()) return setFormError("اكتب اسم العبوة (مثل كرتونة أو كيس)");
    if (!f || f <= 0) return setFormError("اكتب كم تحتوي العبوة من الوحدة (أكبر من صفر)");
    setSaving(true);
    setFormError(null);
    try {
      await invoke("save_ingredient_unit_v3", { sessionToken: token, ingredientId: ing.id, packId: editId, nameAr: name.trim(), factorToStockUnit: f });
      toast.success("تم حفظ العبوة ✓");
      reset();
      await reload();
    } catch (err) {
      setFormError(realErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: IngredientPack) => {
    if (!window.confirm(`حذف العبوة «${p.name_ar}» من ${p.ingredient_name}؟`)) return;
    try {
      await invoke("delete_ingredient_unit_v3", { sessionToken: token, packId: p.id });
      toast.success("تم حذف العبوة");
      await reload();
    } catch (err) {
      toast.error(realErrorText(err));
    }
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-ink-500 font-arabic">جاري التحميل...</div>;

  return (
    <div className="space-y-6">
      {error && <div className={errBox}>{error}</div>}

      <div className="zc-card overflow-hidden">
        <div className="px-6 py-3 bg-white/80 border-b border-ink-200 text-sm font-bold text-ink-900 font-arabic">وحدات القياس</div>
        <div className="grid grid-cols-3 gap-4 px-6 py-2 border-b border-ink-200">
          <div className={thCls}>الوحدة</div>
          <div className={thCls}>النوع</div>
          <div className={thCls}>القيمة</div>
        </div>
        {units.map((u) => (
          <div key={u.code} className="grid grid-cols-3 gap-4 px-6 py-2.5 border-b border-ink-50 text-sm">
            <div className="text-ink-900 font-medium">{u.name_ar}</div>
            <div className="text-ink-400">{KIND_LABEL[u.kind]}</div>
            <div className="text-ink-400 font-mono" dir="ltr">
              {u.factor === 1 ? "—" : `1 ${u.name_ar} = ${u.factor} ${baseName(u.kind)}`}
            </div>
          </div>
        ))}
        <p className="px-6 py-3 text-xs text-ink-500 font-arabic">
          يحوّل النظام تلقائياً بين وحدات النوع الواحد فقط (وزن مع وزن، حجم مع حجم). مثلاً وصفة بـ 150 غرام لمادة مخزنة بالكيلو تنقص 0.15 كجم.
        </p>
      </div>

      <div className="zc-card p-6 space-y-4">
        <div>
          <h3 className="text-sm font-bold text-ink-900 font-arabic">عبوات المواد (كرتونة، كيس، علبة...)</h3>
          <p className="text-xs text-ink-500 font-arabic mt-1">عرّف العبوة مرة واحدة، ثم اطلبها في طلبية الشراء بالكرتونة ويحوّلها النظام إلى وحدة المخزون عند الاستلام.</p>
        </div>
        {formError && <div className={errBox}>{formError}</div>}
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-xs text-ink-400 mb-1 font-arabic">المادة</label>
            <select value={ingredientId} onChange={(e) => { setIngredientId(e.target.value); reset(); }} className={`${inputCls} min-w-[12rem]`} disabled={!!editId}>
              <option value="">اختر المادة</option>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-400 mb-1 font-arabic">اسم العبوة</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="كرتونة" className={`${inputCls} w-36`} />
          </div>
          <div>
            <label className="block text-xs text-ink-400 mb-1 font-arabic">تحتوي {ing ? `(${unitLabel(ing.unit)})` : ""}</label>
            <input type="number" min="0" step="any" value={factor} onChange={(e) => setFactor(e.target.value)} placeholder="10" className={`${inputCls} w-28 font-mono`} dir="ltr" />
          </div>
          <button onClick={save} disabled={!ing || saving} className={primaryBtn}>{saving ? "..." : editId ? "حفظ التعديل" : "إضافة العبوة"}</button>
          {editId && <button onClick={reset} className={ghostBtn}>إلغاء التعديل</button>}
        </div>

        {packs.length === 0 ? (
          <EmptyState title="لا توجد عبوات معرّفة" description="اختر مادة وأضف أول عبوة لها" />
        ) : (
          <div className="border border-ink-200 rounded-sm overflow-hidden">
            {packs.map((p) => (
              <div key={p.id} className="grid grid-cols-4 gap-4 px-4 py-2.5 items-center border-b border-ink-50 last:border-b-0 text-sm">
                <div className="text-ink-900 font-medium">{p.ingredient_name}</div>
                <div className="text-ink-900">{p.name_ar}</div>
                <div className="text-ink-400 font-mono" dir="ltr">{trimNum(p.factor_to_stock_unit)} {unitLabel(p.stock_unit)}</div>
                <div className="flex justify-end gap-1">
                  <button
                    onClick={() => { setIngredientId(p.ingredient_id); setEditId(p.id); setName(p.name_ar); setFactor(String(p.factor_to_stock_unit)); setFormError(null); }}
                    className="p-2 rounded-sm text-ink-500 hover:text-blue-500 hover:bg-blue-50 transition-colors" title="تعديل"
                  >
                    <IconPencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => remove(p)} className="p-2 rounded-sm text-ink-500 hover:text-danger hover:bg-danger-soft transition-colors" title="حذف">
                    <IconTrash className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================ الإنتاج ============================ */

interface BatchLineRow {
  id: string;
  component_id: string;
  component_name: string;
  component_unit: string;
  quantity: number;
  unit: string | null;
  component_stock: number;
  component_cost_cents: number;
  line_cost_cents: number;
}

interface BatchRecipe {
  ingredient_id: string;
  name: string;
  unit: string;
  batch_yield: number;
  current_stock: number;
  cost_cents_per_unit: number;
  lines: BatchLineRow[];
  batch_cost_cents: number;
}

interface ProductionRun {
  id: string;
  produced_id: string;
  produced_name: string;
  unit: string;
  batches: number;
  expected_qty: number;
  actual_qty: number;
  yield_pct: number;
  cost_cents: number;
  unit_cost_cents: number;
  staff_name: string | null;
  created_at: string;
  notes: string | null;
}

interface ProduceOutcome {
  run_id: string;
  expected_qty: number;
  actual_qty: number;
  cost_cents: number;
  new_avg_cost_cents: number;
  negative_components: { ingredient_id: string; name: string; unit: string; stock_after: number }[];
}

interface DraftLine {
  component_id: string;
  quantity: string;
  unit: string;
}

export function ProductionTab({ onChanged }: { onChanged?: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const { ingredients, packs, error, loading, reload } = useInventoryData();
  const [recipes, setRecipes] = useState<BatchRecipe[]>([]);
  const [runs, setRuns] = useState<ProductionRun[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ ingredientId: string } | null>(null);
  const [producing, setProducing] = useState<BatchRecipe | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, h] = await Promise.all([
        invoke<BatchRecipe[]>("list_batch_recipes_v3", { sessionToken: token }),
        invoke<ProductionRun[]>("list_production_runs_v3", { sessionToken: token, ingredientId: null, limit: 100 }),
      ]);
      setRecipes(r);
      setRuns(h);
      setLoadError(null);
    } catch (err) {
      setLoadError(`حدث خطأ في تحميل الإنتاج: ${realErrorText(err)}`);
    }
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);

  const refreshAll = async () => {
    await Promise.all([load(), reload()]);
    onChanged?.();
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-ink-500 font-arabic">جاري التحميل...</div>;

  return (
    <div className="space-y-6">
      {(error || loadError) && <div className={errBox}>{error || loadError}</div>}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-500 font-arabic">منتجات أساسية تحضّرها في مطبعك (صلصة، عجين...) من مواد أخرى، ثم تستعملها في وصفات الأصناف كأي مادة.</p>
        <button onClick={() => setEditing({ ingredientId: "" })} className={`${primaryBtn} shrink-0`}>+ منتج أساسي جديد</button>
      </div>

      {recipes.length === 0 ? (
        <div className="zc-card">
          <EmptyState title="لا توجد منتجات أساسية" description="عرّف تركيبة الدفعة (المكوّنات وناتجها) لتنتجها من هنا وتُخصم المكوّنات تلقائياً" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {recipes.map((r) => (
            <div key={r.ingredient_id} className="zc-card p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-base font-bold text-ink-900">{r.name}</div>
                  <div className="text-xs text-ink-500 font-arabic mt-0.5">
                    المخزون: <span className="font-mono">{trimNum(r.current_stock)}</span> {unitLabel(r.unit)} — متوسط التكلفة: <span className="font-mono">{formatMoney(r.cost_cents_per_unit)}</span>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => setEditing({ ingredientId: r.ingredient_id })} className="p-2 rounded-sm text-ink-500 hover:text-blue-500 hover:bg-blue-50 transition-colors" title="تعديل التركيبة">
                    <IconPencil className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="text-xs text-ink-500 font-arabic">
                الدفعة الواحدة تنتج <span className="font-mono">{trimNum(r.batch_yield)}</span> {unitLabel(r.unit)} وتكلّف تقريباً <span className="font-mono">{formatMoney(r.batch_cost_cents)}</span>
              </div>
              <ul className="space-y-1">
                {r.lines.map((l) => (
                  <li key={l.id} className="flex items-center justify-between text-sm px-3 py-1.5 rounded-sm bg-ink-50 border border-ink-200">
                    <span className="text-ink-900">{l.component_name}</span>
                    <span className="text-ink-400 font-mono text-xs" dir="ltr">{trimNum(l.quantity)} {unitLabel(l.unit ?? l.component_unit)}</span>
                  </li>
                ))}
              </ul>
              <button onClick={() => setProducing(r)} className={`${primaryBtn} w-full`}>إنتاج الآن</button>
            </div>
          ))}
        </div>
      )}

      <div className="zc-card overflow-hidden">
        <div className="px-6 py-3 bg-white/80 border-b border-ink-200 text-sm font-bold text-ink-900 font-arabic">سجل الإنتاج</div>
        <div className="grid grid-cols-8 gap-3 px-6 py-2 border-b border-ink-200">
          <div className={thCls}>التاريخ</div>
          <div className={thCls}>المنتج</div>
          <div className={`${thCls} text-center`}>الدفعات</div>
          <div className={`${thCls} text-center`}>المتوقع</div>
          <div className={`${thCls} text-center`}>الفعلي</div>
          <div className={`${thCls} text-center`}>نسبة الناتج</div>
          <div className={`${thCls} text-center`}>التكلفة</div>
          <div className={thCls}>بواسطة</div>
        </div>
        {runs.length === 0 ? (
          <p className="px-6 py-6 text-sm text-ink-500 font-arabic text-center">لم يُسجَّل أي إنتاج بعد</p>
        ) : (
          runs.map((r) => (
            <div key={r.id} className="grid grid-cols-8 gap-3 px-6 py-2.5 border-b border-ink-50 text-sm items-center" title={r.notes ?? undefined}>
              <div className="text-xs text-ink-500">{fmtWhen(r.created_at)}</div>
              <div className="text-ink-900 font-medium">{r.produced_name}</div>
              <div className="text-center font-mono">{trimNum(r.batches)}</div>
              <div className="text-center font-mono">{trimNum(r.expected_qty)} <span className="text-xs text-ink-400">{unitLabel(r.unit)}</span></div>
              <div className="text-center font-mono">{trimNum(r.actual_qty)}</div>
              <div className={`text-center font-mono ${r.yield_pct < 95 ? "text-warn" : "text-ink-900"}`}>{r.yield_pct}%</div>
              <div className="text-center font-mono">{formatMoney(r.cost_cents)}</div>
              <div className="text-xs text-ink-500">{r.staff_name ?? "—"}</div>
            </div>
          ))
        )}
      </div>

      {editing && (
        <BatchRecipeEditor
          ingredients={ingredients}
          packs={packs}
          recipes={recipes}
          startId={editing.ingredientId}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); toast.success("تم حفظ التركيبة ✓"); await refreshAll(); }}
        />
      )}
      {producing && (
        <ProduceDialog
          recipe={producing}
          ingredients={ingredients}
          packs={packs}
          onClose={() => setProducing(null)}
          onDone={async () => { setProducing(null); await refreshAll(); }}
        />
      )}
    </div>
  );
}

function BatchRecipeEditor({
  ingredients,
  packs,
  recipes,
  startId,
  onClose,
  onSaved,
}: {
  ingredients: StockIngredient[];
  packs: IngredientPack[];
  recipes: BatchRecipe[];
  startId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const token = useAuthStore((s) => s.token);
  const existing = recipes.find((r) => r.ingredient_id === startId) ?? null;
  const [producedId, setProducedId] = useState(startId);
  const [batchYield, setBatchYield] = useState(existing ? String(existing.batch_yield) : "");
  const [lines, setLines] = useState<DraftLine[]>(
    existing ? existing.lines.map((l) => ({ component_id: l.component_id, quantity: String(l.quantity), unit: l.unit ?? "" })) : [{ component_id: "", quantity: "", unit: "" }],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const produced = ingredients.find((i) => i.id === producedId);
  const candidates = ingredients.filter((i) => !i.is_produced || i.id === startId);
  const setLine = (idx: number, patch: Partial<DraftLine>) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const estimate = useMemo(
    () =>
      batchCost(
        lines.flatMap((l) => {
          const c = ingredients.find((i) => i.id === l.component_id);
          const q = parseFloat(l.quantity);
          return c && q > 0 ? [{ quantity: q, unit: l.unit, stockUnit: c.unit, costCents: c.cost_cents_per_unit, packs: packsOf(packs, c.id) }] : [];
        }),
      ),
    [lines, ingredients, packs],
  );

  const save = async (remove = false) => {
    if (!produced || saving) return;
    const y = parseFloat(batchYield);
    const filled = lines.filter((l) => l.component_id);
    if (!remove) {
      if (!y || y <= 0) return setError("اكتب كمية الناتج من الدفعة الواحدة");
      if (filled.length === 0) return setError("أضف مكوّناً واحداً على الأقل");
      if (filled.some((l) => !(parseFloat(l.quantity) > 0))) return setError("اكتب كمية لكل مكوّن (أكبر من صفر)");
    }
    setSaving(true);
    setError(null);
    try {
      await invoke("save_batch_recipe_v3", {
        sessionToken: token,
        ingredientId: produced.id,
        batchYield: remove ? 0 : y,
        lines: remove ? [] : filled.map((l) => ({ component_id: l.component_id, quantity: parseFloat(l.quantity), unit: l.unit || null })),
      });
      onSaved();
    } catch (err) {
      setError(realErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={existing ? `تركيبة ${existing.name}` : "منتج أساسي جديد"} onClose={onClose} wide>
      {error && <div className={errBox}>{error}</div>}
      <div className="space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[10rem]">
            <label className="block text-xs text-ink-400 mb-1 font-arabic">المنتج (مادة من المخزون)</label>
            <select value={producedId} onChange={(e) => setProducedId(e.target.value)} disabled={!!existing} className={`${inputCls} w-full`}>
              <option value="">اختر المادة</option>
              {candidates.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-400 mb-1 font-arabic">ناتج الدفعة الواحدة {produced ? `(${unitLabel(produced.unit)})` : ""}</label>
            <input type="number" min="0" step="any" value={batchYield} onChange={(e) => setBatchYield(e.target.value)} className={`${inputCls} w-32 font-mono`} dir="ltr" />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-bold text-ink-900 font-arabic">المكوّنات لدفعة واحدة</label>
            <button onClick={() => setLines((p) => [...p, { component_id: "", quantity: "", unit: "" }])} className="px-3 py-1.5 rounded-sm bg-indigo-100 text-indigo-700 text-xs font-bold hover:bg-indigo-200 transition-colors">+ مكوّن</button>
          </div>
          {lines.map((l, idx) => {
            const comp = ingredients.find((i) => i.id === l.component_id);
            return (
              <div key={idx} className="flex gap-2 items-start">
                <select value={l.component_id} onChange={(e) => setLine(idx, { component_id: e.target.value, unit: "" })} className={`${inputCls} flex-1`}>
                  <option value="">اختر المكوّن</option>
                  {ingredients.filter((i) => i.id !== producedId).map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
                <input type="number" min="0" step="any" value={l.quantity} onChange={(e) => setLine(idx, { quantity: e.target.value })} placeholder="الكمية" className={`${inputCls} w-24 font-mono`} dir="ltr" />
                {comp ? (
                  <UnitSelect stockUnit={comp.unit} packs={packsOf(packs, comp.id)} value={l.unit} onChange={(v) => setLine(idx, { unit: v })} />
                ) : (
                  <span className="w-24" />
                )}
                <button onClick={() => setLines((p) => p.filter((_, i) => i !== idx))} className="h-10 px-3 rounded-sm text-danger hover:bg-danger-soft transition-colors" aria-label="حذف المكوّن">
                  <IconX className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="text-sm text-ink-500 font-arabic">
          تكلفة الدفعة تقريباً: <span className="font-mono font-bold text-saffron-600">{formatMoney(estimate)}</span>
          {parseFloat(batchYield) > 0 && (
            <> — للوحدة الواحدة: <span className="font-mono font-bold text-ink-900">{formatMoney(Math.round(estimate / parseFloat(batchYield)))}</span></>
          )}
        </div>

        <div className="flex gap-2 pt-2">
          {existing && (
            <button onClick={() => { if (window.confirm("إلغاء تركيبة الإنتاج؟ تبقى المادة في المخزون كمادة عادية.")) save(true); }} disabled={saving} className="px-4 h-10 rounded-sm border border-danger text-danger text-sm font-bold hover:bg-danger-soft transition-colors disabled:opacity-40">إلغاء التركيبة</button>
          )}
          <button onClick={onClose} className={ghostBtn}>إغلاق</button>
          <button onClick={() => save(false)} disabled={!produced || saving} className={`${primaryBtn} flex-1`}>{saving ? "جاري..." : "حفظ التركيبة"}</button>
        </div>
      </div>
    </Dialog>
  );
}

function ProduceDialog({
  recipe,
  ingredients,
  packs,
  onClose,
  onDone,
}: {
  recipe: BatchRecipe;
  ingredients: StockIngredient[];
  packs: IngredientPack[];
  onClose: () => void;
  onDone: () => void;
}) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [batches, setBatches] = useState("1");
  const [actual, setActual] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const n = parseFloat(batches) || 0;
  const expected = round3(recipe.batch_yield * n);
  const actualNum = actual === "" ? expected : parseFloat(actual) || 0;

  // What each component will need, and what is left (the stock may go below zero; the page warns).
  const needs = recipe.lines.map((l) => {
    const comp = ingredients.find((i) => i.id === l.component_id);
    const f = choiceFactor(l.unit ?? "", l.component_unit, comp ? packsOf(packs, comp.id) : []) ?? 1;
    const need = round3(l.quantity * f * n);
    return { ...l, need, after: round3(l.component_stock - need) };
  });
  const anyShort = needs.some((x) => x.after < 0);

  const submit = async () => {
    if (saving || n <= 0 || actualNum <= 0) return;
    setSaving(true);
    setError(null);
    try {
      const out = await invoke<ProduceOutcome>("produce_batch_v3", {
        sessionToken: token,
        ingredientId: recipe.ingredient_id,
        batches: n,
        actualQty: actual === "" ? null : actualNum,
        notes: notes.trim() || null,
      });
      toast.success(`تم الإنتاج: ${trimNum(out.actual_qty)} ${unitLabel(recipe.unit)} ✓`);
      if (out.negative_components.length > 0) {
        toast.error(`تنبيه: مخزون ${out.negative_components.map((c) => c.name).join("، ")} أصبح بالسالب -- سجّل استلام البضاعة أو صحّح الجرد`, 8000);
      }
      onDone();
    } catch (err) {
      setError(realErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={`إنتاج ${recipe.name}`} onClose={onClose}>
      {error && <div className={errBox}>{error}</div>}
      <div className="space-y-3">
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-xs text-ink-400 mb-1 font-arabic">عدد الدفعات</label>
            <input type="number" min="0" step="any" value={batches} onChange={(e) => setBatches(e.target.value)} className={`${inputCls} w-full font-mono`} dir="ltr" />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-ink-400 mb-1 font-arabic">الناتج الفعلي ({unitLabel(recipe.unit)})</label>
            <input type="number" min="0" step="any" value={actual} onChange={(e) => setActual(e.target.value)} placeholder={String(expected)} className={`${inputCls} w-full font-mono`} dir="ltr" />
          </div>
        </div>
        <p className="text-xs text-ink-500 font-arabic">
          المتوقع: <span className="font-mono">{trimNum(expected)}</span> {unitLabel(recipe.unit)}
          {expected > 0 && actualNum > 0 && <> — نسبة الناتج <span className="font-mono">{yieldPct(expected, actualNum)}%</span></>}
        </p>
        <div className="border border-ink-200 rounded-sm overflow-hidden">
          {needs.map((x) => (
            <div key={x.id} className="flex items-center justify-between px-3 py-2 text-sm border-b border-ink-50 last:border-b-0">
              <span className="text-ink-900">{x.component_name}</span>
              <span className="text-xs font-mono text-ink-500" dir="ltr">
                -{trimNum(x.need)} {unitLabel(x.component_unit)} → <span className={x.after < 0 ? "text-danger font-bold" : ""}>{trimNum(x.after)}</span>
              </span>
            </div>
          ))}
        </div>
        {anyShort && (
          <div className="flex items-start gap-2 bg-warn-soft border border-warn-soft rounded-sm p-3 text-sm text-warn font-arabic">
            <IconAlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>بعض المكوّنات لا يكفي مخزونها المسجّل. سيتم الإنتاج ويصبح مخزونها بالسالب -- غالباً نسيتَ تسجيل استلام بضاعة.</span>
          </div>
        )}
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ملاحظات (اختياري)" className={`${inputCls} w-full`} />
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className={ghostBtn}>إلغاء</button>
          <button onClick={submit} disabled={saving || n <= 0 || actualNum <= 0} className={`${primaryBtn} flex-1`}>{saving ? "جاري..." : "تأكيد الإنتاج"}</button>
        </div>
      </div>
    </Dialog>
  );
}

/* ============================ الهدر ============================ */

interface WasteRow {
  id: string;
  ingredient_id: string;
  ingredient_name: string;
  unit: string;
  quantity: number;
  reason: string;
  value_cents: number;
  staff_name: string | null;
  created_at: string;
}

interface WasteOutcome {
  quantity: number;
  value_cents: number;
  stock_after: number;
  below_zero: boolean;
}

function monthStart(): string {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function WasteTab({ onChanged }: { onChanged?: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const { ingredients, packs, error, loading, reload } = useInventoryData();
  const [ingredientId, setIngredientId] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [reason, setReason] = useState<string>(WASTE_REASONS[0]);
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(ymd(new Date()));
  const [rows, setRows] = useState<WasteRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  const ing = ingredients.find((i) => i.id === ingredientId);

  const loadRows = useCallback(async () => {
    if (!from || !to) return;
    try {
      const [start, end] = dayRangeIso(from, to);
      setRows(await invoke<WasteRow[]>("list_waste_v3", { sessionToken: token, rangeStartIso: start, rangeEndIso: end }));
      setListError(null);
    } catch (err) {
      setListError(`حدث خطأ في تحميل الهدر: ${realErrorText(err)}`);
    }
  }, [token, from, to]);
  useEffect(() => {
    loadRows();
  }, [loadRows]);

  const submit = async () => {
    if (!ing || saving) return;
    const q = parseFloat(qty);
    if (!q || q <= 0) return setFormError("اكتب الكمية (أكبر من صفر)");
    setSaving(true);
    setFormError(null);
    try {
      const out = await invoke<WasteOutcome>("record_waste_v3", { sessionToken: token, ingredientId: ing.id, quantity: q, unit: unit || null, reason, note: note.trim() || null });
      toast.success(`سُجّل الهدر: ${trimNum(out.quantity)} ${unitLabel(ing.unit)} بقيمة ${formatMoney(out.value_cents)} ✓`);
      if (out.below_zero) toast.error(`تنبيه: مخزون ${ing.name} أصبح بالسالب (${trimNum(out.stock_after)}) -- راجع الاستلام أو الجرد`, 8000);
      setQty("");
      setNote("");
      await Promise.all([loadRows(), reload()]);
      onChanged?.();
    } catch (err) {
      setFormError(realErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const total = rows.reduce((s, r) => s + r.value_cents, 0);

  if (loading) return <div className="flex items-center justify-center h-64 text-ink-500 font-arabic">جاري التحميل...</div>;

  return (
    <div className="space-y-6">
      {error && <div className={errBox}>{error}</div>}
      <div className="zc-card p-6 space-y-3">
        <h3 className="text-sm font-bold text-ink-900 font-arabic">تسجيل هدر أو تالف</h3>
        {formError && <div className={errBox}>{formError}</div>}
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-xs text-ink-400 mb-1 font-arabic">المادة</label>
            <select value={ingredientId} onChange={(e) => { setIngredientId(e.target.value); setUnit(""); }} className={`${inputCls} min-w-[12rem]`}>
              <option value="">اختر المادة</option>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-400 mb-1 font-arabic">الكمية</label>
            <div className="flex gap-1">
              <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} className={`${inputCls} w-24 font-mono`} dir="ltr" />
              {ing && <UnitSelect stockUnit={ing.unit} packs={packsOf(packs, ing.id)} value={unit} onChange={setUnit} />}
            </div>
          </div>
          <div>
            <label className="block text-xs text-ink-400 mb-1 font-arabic">السبب</label>
            <select value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls}>
              {WASTE_REASONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[10rem]">
            <label className="block text-xs text-ink-400 mb-1 font-arabic">ملاحظة (اختياري)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputCls} w-full`} />
          </div>
          <button onClick={submit} disabled={!ing || saving} className={primaryBtn}>{saving ? "..." : "تسجيل الهدر"}</button>
        </div>
        {ing && (
          <p className="text-xs text-ink-500 font-arabic">
            المتوفر: <span className="font-mono">{trimNum(ing.current_stock)}</span> {unitLabel(ing.unit)} — يُحسب الهدر بمتوسط التكلفة الحالي ({formatMoney(ing.cost_cents_per_unit)} للوحدة).
          </p>
        )}
      </div>

      <div className="space-y-3">
        {listError && <div className={errBox}>{listError}</div>}
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="block text-xs text-ink-400 mb-1 font-arabic">من</label>
            <DatePicker value={from} onChange={setFrom} className="h-10 px-3 pl-10 rounded-sm border-2 border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-600" />
          </div>
          <div>
            <label className="block text-xs text-ink-400 mb-1 font-arabic">إلى</label>
            <DatePicker value={to} onChange={setTo} className="h-10 px-3 pl-10 rounded-sm border-2 border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-600" />
          </div>
          <div className="zc-card px-4 py-2 mr-auto">
            <div className="text-xs text-ink-400 font-arabic">إجمالي قيمة الهدر في الفترة</div>
            <div className="text-lg font-bold text-danger font-mono">{formatMoney(total)}</div>
          </div>
        </div>
        <div className="zc-card overflow-hidden">
          <div className="grid grid-cols-6 gap-3 px-6 py-3 bg-white/80 border-b border-ink-200">
            <div className={thCls}>التاريخ</div>
            <div className={thCls}>المادة</div>
            <div className={`${thCls} text-center`}>الكمية</div>
            <div className={thCls}>السبب</div>
            <div className={`${thCls} text-center`}>القيمة</div>
            <div className={thCls}>بواسطة</div>
          </div>
          {rows.length === 0 ? (
            <EmptyState title="لا يوجد هدر مسجّل في هذه الفترة" />
          ) : (
            rows.map((r) => (
              <div key={r.id} className="grid grid-cols-6 gap-3 px-6 py-2.5 border-b border-ink-50 text-sm items-center">
                <div className="text-xs text-ink-500">{fmtWhen(r.created_at)}</div>
                <div className="text-ink-900 font-medium">{r.ingredient_name}</div>
                <div className="text-center font-mono">{trimNum(r.quantity)} <span className="text-xs text-ink-400">{unitLabel(r.unit)}</span></div>
                <div className="text-ink-900">{r.reason}</div>
                <div className="text-center font-mono text-danger">{formatMoney(r.value_cents)}</div>
                <div className="text-xs text-ink-500">{r.staff_name ?? "—"}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ============== تقرير حركة المخزون (inside the stock tab) ============== */

interface ReportRow {
  ingredient_id: string;
  name: string;
  unit: string;
  on_hand: number;
  avg_cost_cents: number;
  value_cents: number;
  received: number;
  used_sales: number;
  produced: number;
  used_production: number;
  wasted: number;
  wasted_value_cents: number;
  adjusted: number;
}

interface StockReport {
  rows: ReportRow[];
  total_value_cents: number;
  waste_value_cents: number;
  received_value_cents: number;
}

export function StockMovementReport({ refreshKey }: { refreshKey: number }) {
  const token = useAuthStore((s) => s.token);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(ymd(new Date()));
  const [report, setReport] = useState<StockReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    const [start, end] = dayRangeIso(from, to);
    invoke<StockReport>("get_stock_report_v3", { sessionToken: token, rangeStartIso: start, rangeEndIso: end })
      .then((r) => { setReport(r); setError(null); })
      .catch((err) => setError(`حدث خطأ في تحميل التقرير: ${realErrorText(err)}`));
  }, [token, from, to, refreshKey]);

  const num = (x: number) => (x === 0 ? "—" : trimNum(x));

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-bold text-ink-900 font-arabic">حركة المخزون في فترة</h3>
      {error && <div className={errBox}>{error}</div>}
      <div className="flex gap-3 flex-wrap items-end">
        <div>
          <label className="block text-xs text-ink-400 mb-1 font-arabic">من</label>
          <DatePicker value={from} onChange={setFrom} className="h-10 px-3 pl-10 rounded-sm border-2 border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-600" />
        </div>
        <div>
          <label className="block text-xs text-ink-400 mb-1 font-arabic">إلى</label>
          <DatePicker value={to} onChange={setTo} className="h-10 px-3 pl-10 rounded-sm border-2 border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-600" />
        </div>
        {report && (
          <div className="flex gap-3 mr-auto">
            <div className="zc-card px-4 py-2">
              <div className="text-xs text-ink-400 font-arabic">قيمة المشتريات المستلمة</div>
              <div className="text-base font-bold text-ink-900 font-mono">{formatMoney(report.received_value_cents)}</div>
            </div>
            <div className="zc-card px-4 py-2">
              <div className="text-xs text-ink-400 font-arabic">قيمة الهدر</div>
              <div className="text-base font-bold text-danger font-mono">{formatMoney(report.waste_value_cents)}</div>
            </div>
          </div>
        )}
      </div>
      <div className="zc-card overflow-x-auto">
        <div className="min-w-[44rem]">
          <div className="grid grid-cols-8 gap-3 px-6 py-3 bg-white/80 border-b border-ink-200">
            <div className={thCls}>المادة</div>
            <div className={`${thCls} text-center`}>استلام</div>
            <div className={`${thCls} text-center`}>استُعمل بالبيع</div>
            <div className={`${thCls} text-center`}>أُنتج</div>
            <div className={`${thCls} text-center`}>استُعمل بالإنتاج</div>
            <div className={`${thCls} text-center`}>هدر</div>
            <div className={`${thCls} text-center`}>تعديل / جرد</div>
            <div className={`${thCls} text-center`}>قيمة الهدر</div>
          </div>
          {(report?.rows ?? []).map((r) => (
            <div key={r.ingredient_id} className="grid grid-cols-8 gap-3 px-6 py-2 border-b border-ink-50 text-sm items-center">
              <div className="text-ink-900 font-medium">{r.name} <span className="text-xs text-ink-400">{unitLabel(r.unit)}</span></div>
              <div className="text-center font-mono">{num(r.received)}</div>
              <div className="text-center font-mono">{num(r.used_sales)}</div>
              <div className="text-center font-mono">{num(r.produced)}</div>
              <div className="text-center font-mono">{num(r.used_production)}</div>
              <div className="text-center font-mono">{num(r.wasted)}</div>
              <div className="text-center font-mono" dir="ltr">{r.adjusted > 0 ? `+${trimNum(r.adjusted)}` : num(r.adjusted)}</div>
              <div className="text-center font-mono text-danger">{r.wasted_value_cents ? formatMoney(r.wasted_value_cents) : "—"}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
