import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney } from "../../lib/money";
import { formatQty } from "../../lib/shop";
import { Field, Hint, Modal, btnGhost, btnPrimary, inputCls } from "../payroll/ui";

export interface StockRow {
  menu_item_id: string;
  name: string;
  barcode: string | null;
  category: string | null;
  price_cents: number;
  cost_cents: number;
  sold_by: "unit" | "weight";
  track_stock: boolean;
  quantity: number;
  min_quantity: number;
  low: boolean;
  value_cents: number;
}

interface ExtraBarcode {
  id: string;
  barcode: string;
  units: number;
}

const unitOf = (r: StockRow) => (r.sold_by === "weight" ? "كغ" : "قطعة");

/** The shelf: every tracked product with what is left, alerts for what is running out, and the actions on each. */
export default function StockTab({ refreshKey, onChanged, onGoImport }: { refreshKey: number; onChanged: () => void; onGoImport: () => void }) {
  const token = useAuthStore((s) => s.token);
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [showUntracked, setShowUntracked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ kind: "count" | "adjust" | "settings"; row: StockRow } | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setRows(await invoke<StockRow[]>("list_product_stock_v3", { sessionToken: token, search: search || null, onlyLow, includeUntracked: showUntracked }));
    } catch (err) {
      setError(realErrorText(err));
    }
  }, [token, search, onlyLow, showUntracked]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const tracked = (rows ?? []).filter((r) => r.track_stock);
  const lowCount = tracked.filter((r) => r.low).length;
  const value = tracked.reduce((a, r) => a + r.value_cents, 0);

  return (
    <div className="space-y-4" data-testid="stock-tab">
      <Hint summary="كل منتج تفعّل «تتبع المخزون» له يحسب النظام كميته وحده.">
        <p>الاستلام والاستيراد يفعّلان التتبع تلقائياً. الكمية بالقطعة، وللمنتجات التي تُباع بالوزن بالكيلوغرام.</p>
        <p>يستمر البيع حتى لو نفد المخزون على الورق (قد تكون البضاعة وصلت ولم تُسجَّل). يظهر تنبيه عند المسح، وتستطيع من «الباركود والإعدادات» منع البيع عند نفاد المخزون.</p>
        <p>«جرد» يجعل الكمية تساوي ما عددته فعلاً على الرف، ويُسجَّل الفرق في «الحركات».</p>
      </Hint>

      <div className="grid grid-cols-3 gap-4">
        <div className="zc-card p-4"><p className="text-ink-400 text-sm font-arabic">منتجات مُتتبَّعة</p><p className="text-2xl font-bold font-mono" data-testid="stock-tracked">{tracked.length}</p></div>
        <div className="zc-card p-4"><p className="text-ink-400 text-sm font-arabic">أوشكت على النفاد</p><p className={`text-2xl font-bold font-mono ${lowCount > 0 ? "text-danger" : "text-ink-900"}`} data-testid="stock-low">{lowCount}</p></div>
        <div className="zc-card p-4"><p className="text-ink-400 text-sm font-arabic">قيمة المخزون بسعر التكلفة</p><p className="text-2xl font-bold text-saffron-600 font-mono">{formatMoney(value)}</p></div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالاسم أو الباركود" className={`${inputCls} max-w-xs`} data-testid="stock-search" />
        <label className="flex items-center gap-2 text-sm font-arabic"><input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} data-testid="stock-only-low" /> المنخفض فقط</label>
        <label className="flex items-center gap-2 text-sm font-arabic"><input type="checkbox" checked={showUntracked} onChange={(e) => setShowUntracked(e.target.checked)} data-testid="stock-show-untracked" /> أظهر المنتجات غير المُتتبَّعة</label>
      </div>
      {error && <p className="text-danger font-arabic text-sm">{error}</p>}

      <div className="zc-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
              <th className="text-right p-3 font-medium">المنتج</th>
              <th className="text-right p-3 font-medium">الباركود</th>
              <th className="text-center p-3 font-medium">الكمية</th>
              <th className="text-center p-3 font-medium">الحد الأدنى</th>
              <th className="text-center p-3 font-medium">الحالة</th>
              <th className="text-center p-3 font-medium">القيمة</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.menu_item_id} className="border-b border-ink-100 hover:bg-saffron-50" data-testid={`stock-row-${r.menu_item_id}`}>
                <td className="p-3 font-arabic font-medium text-ink-900">{r.name}{r.category && <span className="block text-[11px] text-ink-400">{r.category}</span>}</td>
                <td className="p-3 font-mono text-ink-500" dir="ltr">{r.barcode ?? "—"}</td>
                <td className={`p-3 text-center font-mono font-bold ${r.quantity < 0 ? "text-danger" : "text-ink-900"}`} data-testid={`stock-qty-${r.menu_item_id}`}>{r.track_stock ? `${formatQty(r.quantity)} ${unitOf(r)}` : "—"}</td>
                <td className="p-3 text-center font-mono text-ink-500">{r.track_stock ? formatQty(r.min_quantity) : "—"}</td>
                <td className="p-3 text-center font-arabic">
                  {!r.track_stock ? <span className="text-ink-400">غير مُتتبَّع</span> : r.quantity <= 0 ? <span className="px-2 py-0.5 rounded-full bg-danger-100 text-danger-600 text-xs">نفد</span> : r.low ? <span className="px-2 py-0.5 rounded-full bg-warn-100 text-warn-700 text-xs">منخفض</span> : <span className="px-2 py-0.5 rounded-full bg-ok-100 text-ok-700 text-xs">متوفر</span>}
                </td>
                <td className="p-3 text-center font-mono text-ink-500">{r.track_stock ? formatMoney(r.value_cents) : "—"}</td>
                <td className="p-3 text-left whitespace-nowrap">
                  <button onClick={() => setModal({ kind: "count", row: r })} className="text-saffron-600 font-bold font-arabic ml-3" data-testid={`stock-count-${r.menu_item_id}`}>جرد</button>
                  <button onClick={() => setModal({ kind: "adjust", row: r })} className="text-ink-700 font-arabic ml-3" data-testid={`stock-adjust-${r.menu_item_id}`}>تعديل</button>
                  <button onClick={() => setModal({ kind: "settings", row: r })} className="text-ink-500 font-arabic" data-testid={`stock-settings-${r.menu_item_id}`}>إعدادات</button>
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-8 text-center font-arabic text-ink-500 space-y-2" data-testid="stock-empty">
                  <p>{showUntracked || search || onlyLow ? "لا توجد منتجات مطابقة." : "لم تُفعَّل متابعة المخزون لأي منتج بعد."}</p>
                  {!search && !onlyLow && !showUntracked && (
                    <p>
                      <button onClick={onGoImport} className="text-saffron-600 font-bold">استورد منتجاتك مع كمياتها من ملف</button>
                      <span> أو افتح «استلام بضاعة» وامسح باركودات ما وصلك، أو علّم «أظهر المنتجات غير المُتتبَّعة» وفعّل التتبع لكل منتج.</span>
                    </p>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal?.kind === "count" && <CountModal row={modal.row} onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />}
      {modal?.kind === "adjust" && <AdjustModal row={modal.row} onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />}
      {modal?.kind === "settings" && <ProductModal row={modal.row} onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />}
    </div>
  );
}

function CountModal({ row, onClose, onDone }: { row: StockRow; onClose: () => void; onDone: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [counted, setCounted] = useState(String(row.track_stock ? row.quantity : ""));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const n = Number(counted.replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || counted.trim() === "") { toast.error("اكتب الكمية التي عددتها"); return; }
    setBusy(true);
    try {
      await invoke("count_product_stock_v3", { sessionToken: token, itemId: row.menu_item_id, counted: n, note: note || null });
      toast.success("تم الجرد");
      onDone();
    } catch (err) { toast.error(realErrorText(err)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`جرد ${row.name}`} onClose={onClose}>
      <Hint summary={`الكمية التي في النظام الآن: ${row.track_stock ? formatQty(row.quantity) : 0} ${unitOf(row)}. اكتب ما عددته فعلاً على الرف.`} />
      <Field label={`الكمية المجرودة (${unitOf(row)})`}><input value={counted} onChange={(e) => setCounted(e.target.value)} className={inputCls} dir="ltr" inputMode="decimal" data-testid="count-input" /></Field>
      <Field label="ملاحظة (اختياري)"><input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} /></Field>
      <div className="flex justify-end gap-3"><button onClick={onClose} className={btnGhost}>إلغاء</button><button onClick={save} disabled={busy} className={btnPrimary} data-testid="count-save">{busy ? "جاري..." : "تسجيل الجرد"}</button></div>
    </Modal>
  );
}

function AdjustModal({ row, onClose, onDone }: { row: StockRow; onClose: () => void; onDone: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [sign, setSign] = useState<1 | -1>(-1);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const n = Number(qty.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) { toast.error("اكتب كمية أكبر من صفر"); return; }
    if (!note.trim()) { toast.error("اكتب سبب التعديل"); return; }
    setBusy(true);
    try {
      await invoke("adjust_product_stock_v3", { sessionToken: token, itemId: row.menu_item_id, change: sign * n, note });
      toast.success("تم التعديل");
      onDone();
    } catch (err) { toast.error(realErrorText(err)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`تعديل مخزون ${row.name}`} onClose={onClose}>
      <Hint summary="للتالف أو المفقود أو ما وُجد زائداً. للاستلام من مورد استعمل «استلام بضاعة»." />
      <div className="flex gap-2">
        <button type="button" onClick={() => setSign(-1)} className={`flex-1 h-10 rounded-sm border text-sm font-arabic ${sign === -1 ? "bg-saffron-600 text-white border-saffron-600" : "bg-white border-ink-200"}`} data-testid="adjust-minus">إنقاص</button>
        <button type="button" onClick={() => setSign(1)} className={`flex-1 h-10 rounded-sm border text-sm font-arabic ${sign === 1 ? "bg-saffron-600 text-white border-saffron-600" : "bg-white border-ink-200"}`} data-testid="adjust-plus">إضافة</button>
      </div>
      <Field label={`الكمية (${unitOf(row)})`}><input value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} dir="ltr" inputMode="decimal" data-testid="adjust-qty" /></Field>
      <Field label="السبب (إجباري)"><input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="تالف، منتهي الصلاحية، وُجد في المخزن…" data-testid="adjust-note" /></Field>
      <div className="flex justify-end gap-3"><button onClick={onClose} className={btnGhost}>إلغاء</button><button onClick={save} disabled={busy} className={btnPrimary} data-testid="adjust-save">{busy ? "جاري..." : "حفظ"}</button></div>
    </Modal>
  );
}

function ProductModal({ row, onClose, onDone }: { row: StockRow; onClose: () => void; onDone: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [track, setTrack] = useState(row.track_stock);
  const [min, setMin] = useState(String(row.min_quantity || ""));
  const [opening, setOpening] = useState("");
  const [extras, setExtras] = useState<ExtraBarcode[]>([]);
  const [code, setCode] = useState("");
  const [units, setUnits] = useState("1");
  const [busy, setBusy] = useState(false);

  const loadExtras = useCallback(async () => {
    try { setExtras(await invoke<ExtraBarcode[]>("list_product_barcodes_v3", { sessionToken: token, itemId: row.menu_item_id })); } catch { /* shown empty */ }
  }, [token, row.menu_item_id]);
  useEffect(() => { loadExtras(); }, [loadExtras]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast.success(ok); } catch (err) { toast.error(realErrorText(err)); } finally { setBusy(false); }
  };

  return (
    <Modal title={row.name} onClose={onClose}>
      <label className="flex items-start gap-2 font-arabic text-sm text-ink-900">
        <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} className="mt-1" data-testid="track-toggle" />
        <span>تتبع مخزون هذا المنتج<span className="block text-xs text-ink-400">يُنقص كل بيع الكمية، ويُنبَّه عند اقترابها من الحد الأدنى.</span></span>
      </label>
      {track && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={`الحد الأدنى للتنبيه (${unitOf(row)})`} hint="عند هذه الكمية أو أقل يظهر «منخفض»."><input value={min} onChange={(e) => setMin(e.target.value)} className={inputCls} dir="ltr" inputMode="decimal" data-testid="track-min" /></Field>
          {!row.track_stock && <Field label="الكمية الحالية على الرف" hint="تُسجَّل كرصيد افتتاحي."><input value={opening} onChange={(e) => setOpening(e.target.value)} className={inputCls} dir="ltr" inputMode="decimal" data-testid="track-opening" /></Field>}
        </div>
      )}
      <div className="flex justify-end">
        <button disabled={busy} className={btnPrimary} data-testid="track-save"
          onClick={() => run(async () => {
            await invoke("set_product_tracking_v3", { sessionToken: token, itemId: row.menu_item_id, track, minQuantity: Number(min.replace(",", ".")) || 0, openingQuantity: opening.trim() === "" ? null : Number(opening.replace(",", ".")) });
            onDone();
          }, "تم الحفظ")}>حفظ</button>
      </div>

      <section className="space-y-2 border-t border-ink-100 pt-3">
        <h3 className="font-bold font-arabic text-ink-900 text-sm">باركودات إضافية</h3>
        <Hint summary="باركود الكرتونة أو صنف مورد آخر لنفس المنتج. «عدد القطع» كم قطعة تُضاف في السلة عند مسح هذا الباركود (كرتونة 12 = 12).">
          <p>الباركود الرئيسي للمنتج يُعدَّل من صفحة المنتجات.</p>
        </Hint>
        {extras.map((b) => (
          <div key={b.id} className="flex items-center justify-between text-sm border-b border-ink-100 py-1">
            <span className="font-mono" dir="ltr">{b.barcode}</span>
            <span className="flex items-center gap-3 font-arabic"><span>{b.units} قطعة</span><button className="text-danger text-xs" onClick={() => run(async () => { await invoke("delete_product_barcode_v3", { sessionToken: token, barcodeId: b.id }); await loadExtras(); })}>حذف</button></span>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-2">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="الباركود (امسحه هنا)" className={`${inputCls} flex-1 min-w-[160px]`} dir="ltr" data-testid="extra-code" />
          <input value={units} onChange={(e) => setUnits(e.target.value)} className={`${inputCls} max-w-[90px]`} dir="ltr" inputMode="numeric" data-testid="extra-units" />
          <button className={btnGhost} disabled={busy} data-testid="extra-add" onClick={() => run(async () => { await invoke("add_product_barcode_v3", { sessionToken: token, itemId: row.menu_item_id, barcode: code, units: Number(units) || 0 }); setCode(""); setUnits("1"); await loadExtras(); }, "أُضيف الباركود")}>إضافة</button>
          <button className={btnGhost} disabled={busy} data-testid="extra-generate" onClick={() => run(async () => setCode(await invoke<string>("generate_product_barcode_v3", { sessionToken: token })))}>توليد باركود</button>
        </div>
      </section>
    </Modal>
  );
}
