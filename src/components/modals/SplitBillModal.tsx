import { useState, useEffect } from "react";
import { IconX, IconPlus } from "@tabler/icons-react";
import { useCartStore } from "../../stores/cartStore";
import type { SplitItem } from "../../stores/cartStore";
import { useCurrency } from "../../hooks/useCurrency";

interface Props {
  onClose: () => void;
  onConfirm: (splits: SplitItem[]) => void;
}

export default function SplitBillModal({ onClose, onConfirm }: Props) {
  const items = useCartStore((s) => s.items);
  const { fmt } = useCurrency();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  const [splits, setSplits] = useState<SplitItem[]>([
    { id: "split-1", label: "الفاتورة ١", itemIds: [], amountCents: 0 },
    { id: "split-2", label: "الفاتورة ٢", itemIds: [], amountCents: 0 },
  ]);

  // Manual per-slot amount, independent of item-toggle assignment. A slot's
  // effective total is item-derived amountCents PLUS whatever's typed in
  // here -- lets a cashier toggle a couple of shared items onto a slot AND
  // top it up (or start it) with a hand-typed number, e.g. "she's covering
  // her plate plus 5,000 toward the shared appetizer."
  const [manualCents, setManualCents] = useState<Record<string, number>>({});

  const totalCents = useCartStore((s) => s.total());

  const effectiveAmountCents = (s: SplitItem) => s.amountCents + (manualCents[s.id] ?? 0);

  const allAssigned = splits.every((s) => s.itemIds.length > 0 || effectiveAmountCents(s) > 0);

  const assignedTotal = splits.reduce((sum, s) => sum + effectiveAmountCents(s), 0);
  const remainder = totalCents - assignedTotal;

  const toggleItem = (splitId: string, itemId: string, itemTotal: number) => {
    setSplits((prev) =>
      prev.map((s) => {
        if (s.id !== splitId) return s;
        const exists = s.itemIds.includes(itemId);
        const newIds = exists
          ? s.itemIds.filter((i) => i !== itemId)
          : [...s.itemIds, itemId];
        const newAmount = exists
          ? s.amountCents - itemTotal
          : s.amountCents + itemTotal;
        return { ...s, itemIds: newIds, amountCents: newAmount };
      })
    );
  };

  const setManualAmount = (splitId: string, value: string) => {
    const cents = Math.max(0, parseInt(value, 10) || 0);
    setManualCents((prev) => ({ ...prev, [splitId]: cents }));
  };

  // Whole SYP only (no fils/decimals in this business) -- integer division
  // for the even share, then the leftover cents (totalCents % N, always
  // < N) are handed out 1-by-1 to the first N slots so every cent is
  // accounted for and the sum of shares is exactly totalCents, never off by
  // a few cents the way naive float division would be.
  const splitEvenly = () => {
    const n = splits.length;
    if (n === 0) return;
    const base = Math.floor(totalCents / n);
    const remainderCents = totalCents % n;
    setSplits((prev) => prev.map((s) => ({ ...s, itemIds: [], amountCents: 0 })));
    setManualCents(() => {
      const next: Record<string, number> = {};
      splits.forEach((s, i) => {
        next[s.id] = base + (i < remainderCents ? 1 : 0);
      });
      return next;
    });
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-md border border-line shadow-sh-3 w-[600px] max-h-[80vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-ink-200 flex items-center justify-between">
          <h2 className="font-arabic font-bold text-lg text-ink-900">تقسيم الفاتورة</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center text-ink-500 shrink-0 transition-colors">
            <IconX className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex gap-3">
            {splits.map((split, _idx) => (
              <div key={split.id} className="flex-1 bg-surface-alt rounded-xl p-4">
                <label className="font-arabic text-sm text-ink-500 mb-2 block">
                  {split.label}
                </label>
                <input
                  type="text"
                  value={split.label}
                  onChange={(e) =>
                    setSplits((prev) =>
                      prev.map((s) => (s.id === split.id ? { ...s, label: e.target.value } : s))
                    )
                  }
                  className="w-full px-3 py-2 rounded-sm border-2 border-ink-200 bg-white font-arabic text-sm mb-2"
                />
                {/* Manual amount, added on top of whatever items are toggled
                    onto this slot below -- lets a slot be "these items + a
                    hand-typed top-up" instead of only pure item assignment. */}
                <label className="font-arabic text-xs text-ink-500 mb-1 block">
                  مبلغ إضافي (يدوي)
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={manualCents[split.id] ?? 0}
                  onChange={(e) => setManualAmount(split.id, e.target.value)}
                  className="w-full px-3 py-2 rounded-sm border-2 border-ink-200 bg-white font-mono text-sm mb-2"
                  dir="ltr"
                />
                {split.itemIds.length > 0 && (
                  <div className="font-arabic text-xs text-ink-400 mb-1">
                    أصناف: {fmt(split.amountCents)}
                  </div>
                )}
                <div className="font-mono font-bold text-lg text-ink-900" dir="ltr">
                  {fmt(effectiveAmountCents(split))}
                </div>
              </div>
            ))}
            <button
              onClick={() =>
                setSplits((prev) => [
                  ...prev,
                  { id: `split-${prev.length + 1}`, label: `الفاتورة ${prev.length + 1}`, itemIds: [], amountCents: 0 },
                ])
              }
              className="w-12 h-full rounded-xl border-2 border-dashed border-ink-300 text-ink-500 hover:border-accent hover:text-accent-text flex items-center justify-center transition-colors"
            >
              <IconPlus className="w-6 h-6" stroke={1.75} />
            </button>
          </div>

          <button
            onClick={splitEvenly}
            className="w-full h-10 rounded-xl bg-accent-soft text-accent-text font-arabic font-bold text-sm hover:opacity-90 transition-opacity"
          >
            قسّم بالتساوي
          </button>

          <div className="bg-surface-alt rounded-xl p-3 flex justify-between items-center">
            <span className="font-arabic text-sm text-text-2">المتبقي للتوزيع</span>
            <span className={`font-mono font-bold ${remainder === 0 ? "text-ok" : "text-warn"}`} dir="ltr">
              {fmt(remainder)}
            </span>
          </div>

          <div className="space-y-2">
              {items.filter((i) => !i.voided).map((item) => {
              const itemTotal = (item.unitPriceCents + item.modifiers.reduce((m, m2) => m + m2.priceCents, 0)) * item.quantity;
              return (
                <div key={item.id} className="flex items-center gap-2 bg-surface border border-ink-200 rounded-xl p-3">
                  <span className="font-arabic flex-1 text-sm">{item.quantity}× {item.name}</span>
                  <span className="font-mono text-sm text-ink-500 ml-2" dir="ltr">
                    {fmt(itemTotal)}
                  </span>
                  {splits.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => toggleItem(s.id, item.id, itemTotal)}
                      className={`px-2 py-1 rounded-lg text-xs font-arabic transition-colors ${
                        s.itemIds.includes(item.id)
                          ? "bg-ink-900 text-white"
                          : "bg-surface-alt text-ink-400 hover:bg-ink-200"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-ink-200 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 h-12 rounded-xl bg-surface-alt text-ink-900 font-arabic font-bold hover:bg-ink-200"
          >
            إلغاء
          </button>
          <button
            onClick={() => onConfirm(splits.map((s) => ({ ...s, amountCents: effectiveAmountCents(s) })))}
            disabled={!allAssigned || remainder !== 0}
            className="flex-1 h-12 rounded-xl bg-saffron-600 text-white font-arabic font-bold hover:bg-accent-text disabled:opacity-50"
          >
            تأكيد التقسيم
          </button>
        </div>
      </div>
    </div>
  );
}
