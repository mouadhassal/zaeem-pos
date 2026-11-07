import UsdHelper from "../../components/ui/UsdHelper";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney, minorToInputValue, parseMoneyInput } from "../../lib/money";
import { NO_SHOP_SETTINGS, resolveScan, type ScanItem } from "../../lib/shop";
import { Field, Hint, btnGhost, btnPrimary, inputCls } from "../payroll/ui";

interface Product extends ScanItem {
  cost_cents: number;
  is_active: number;
}

interface Line {
  id: string;
  name: string;
  sold_by: "unit" | "weight";
  quantity: string;
  cost: string;
  oldCost: number;
}

/**
 * Goods arrive: scan each product's barcode (a scanner types the code and presses Enter), the quantity
 * counts up with every scan, then confirm. The stock goes up and, if the delivery changed the cost, the
 * cost price follows so the margin profit stays true.
 */
export default function ReceiveTab({ onDone }: { onDone: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const rows = await invoke<(Product & { extra_barcodes?: { barcode: string; units: number }[] })[]>("list_menu_items_v3", { sessionToken: token });
      setProducts(rows.filter((r) => r.is_active === 1));
    } catch (err) {
      toast.error(realErrorText(err));
    }
  }, [token, toast]);
  useEffect(() => { load(); input.current?.focus(); }, [load]);

  const add = (p: Product, units: number) => {
    setLines((prev) => {
      const at = prev.findIndex((l) => l.id === p.id);
      if (at >= 0) {
        const next = [...prev];
        next[at] = { ...next[at], quantity: String((Number(next[at].quantity) || 0) + units) };
        return next;
      }
      return [...prev, { id: p.id, name: p.name, sold_by: p.sold_by, quantity: String(units), cost: p.cost_cents > 0 ? minorToInputValue(p.cost_cents) : "", oldCost: p.cost_cents }];
    });
  };

  const submitCode = () => {
    const text = code.trim();
    if (!text) return;
    const hit = resolveScan(products, text, NO_SHOP_SETTINGS);
    if (hit.kind === "item") {
      add(hit.item, hit.units);
      setMessage(`أُضيف ${hit.item.name}`);
    } else {
      // Not a barcode: search by name, take the match when it is exactly one product.
      const byName = products.filter((p) => p.name.includes(text));
      if (byName.length === 1) {
        add(byName[0], 1);
        setMessage(`أُضيف ${byName[0].name}`);
      } else if (byName.length > 1) {
        setMessage(`${byName.length} منتجات تطابق «${text}»: اكتب اسماً أدق أو امسح الباركود`);
      } else {
        setMessage(`لا يوجد منتج بهذا الباركود أو الاسم: ${text}. أضفه أولاً من صفحة المنتجات أو الاستيراد`);
      }
    }
    setCode("");
    input.current?.focus();
  };

  const confirm = async () => {
    const payload = lines.map((l) => ({ menu_item_id: l.id, quantity: Number(l.quantity.replace(",", ".")), cost_cents: l.cost.trim() === "" ? null : parseMoneyInput(l.cost) }));
    if (payload.length === 0 || payload.some((p) => !Number.isFinite(p.quantity) || p.quantity <= 0)) {
      toast.error("أدخل كمية صحيحة لكل صنف");
      return;
    }
    setBusy(true);
    try {
      const out = await invoke<{ lines: number; pieces: number }>("receive_products_v3", { sessionToken: token, lines: payload, note: note || null });
      toast.success(`تم الاستلام: ${out.lines} صنف، ${out.pieces} وحدة`);
      onDone();
    } catch (err) {
      toast.error(realErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="receive-tab">
      <Hint summary="امسح باركود كل صنف وصل: يرتفع العدد مع كل مسحة. ثم راجع الكميات وأكّد.">
        <p>يمكنك أيضاً كتابة جزء من الاسم ثم Enter. إن غيّرت «سعر التكلفة» يصير هو تكلفة الصنف من الآن، فيبقى ربح الهامش صحيحاً.</p>
        <p>استلام صنف لم يكن مُتتبَّعاً يفعّل تتبع مخزونه تلقائياً.</p>
      </Hint>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="امسح باركود أو اكتب اسماً ثم Enter">
          <input
            ref={input}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitCode(); } }}
            className={`${inputCls} min-w-[280px]`}
            dir="ltr"
            autoFocus
            data-testid="receive-code"
          />
        </Field>
        <Field label="رقم الفاتورة أو اسم المورد (اختياري)"><input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputCls} min-w-[240px]`} data-testid="receive-note" /></Field>
      </div>
      {message && <p className="text-sm font-arabic text-ink-700" data-testid="receive-message">{message}</p>}

      <div className="zc-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
              <th className="text-right p-3 font-medium">الصنف</th>
              <th className="text-center p-3 font-medium">الكمية المستلمة</th>
              <th className="text-center p-3 font-medium">سعر التكلفة الجديد</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-ink-100" data-testid={`receive-line-${l.id}`}>
                <td className="p-3 font-arabic font-medium">{l.name}<span className="block text-[11px] text-ink-400">{l.sold_by === "weight" ? "بالكيلوغرام" : "بالقطعة"} · تكلفة حالية {l.oldCost ? formatMoney(l.oldCost) : "غير مُدخلة"}</span></td>
                <td className="p-3 text-center"><input value={l.quantity} onChange={(e) => setLines((p) => p.map((x) => (x.id === l.id ? { ...x, quantity: e.target.value } : x)))} className={`${inputCls} max-w-[110px] mx-auto text-center`} dir="ltr" inputMode="decimal" data-testid={`receive-qty-${l.id}`} /></td>
                <td className="p-3 text-center"><div className="flex items-center justify-center gap-1"><input value={l.cost} onChange={(e) => setLines((p) => p.map((x) => (x.id === l.id ? { ...x, cost: e.target.value } : x)))} className={`${inputCls} max-w-[130px] text-center`} dir="ltr" inputMode="decimal" data-testid={`receive-cost-${l.id}`} /><UsdHelper onConvert={(minor) => setLines((p) => p.map((x) => (x.id === l.id ? { ...x, cost: minorToInputValue(minor) } : x)))} /></div></td>
                <td className="p-3 text-left"><button className="text-danger text-xs font-arabic" onClick={() => setLines((p) => p.filter((x) => x.id !== l.id))}>حذف</button></td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-ink-500 font-arabic">لم تُضف أصنافاً بعد. امسح أول باركود.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between">
        <button onClick={() => { setLines([]); input.current?.focus(); }} disabled={lines.length === 0} className={btnGhost}>تفريغ</button>
        <button onClick={confirm} disabled={busy || lines.length === 0} className={btnPrimary} data-testid="receive-confirm">{busy ? "جاري..." : `تأكيد الاستلام (${lines.length})`}</button>
      </div>
    </div>
  );
}
