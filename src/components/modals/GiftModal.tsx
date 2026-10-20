import { useState } from "react";
import { IconGift, IconX } from "@tabler/icons-react";
import { useCurrency } from "../../hooks/useCurrency";

interface Props {
  itemName: string;
  valueCents: number;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

const REASONS = ["ضيافة من المطعم", "تعويض عن خطأ", "ضيف أو صديق", "تجربة صنف جديد", "أخرى"];

/**
 * "On the house": the line stays on the order at its real value (for the
 * report) but is not charged. A reason is always required, and the server
 * records who gave it.
 */
export default function GiftModal({ itemName, valueCents, onConfirm, onCancel }: Props) {
  const { fmt } = useCurrency();
  const [reason, setReason] = useState("");
  const [custom, setCustom] = useState("");
  const finalReason = reason === "أخرى" ? custom.trim() : reason;

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50" data-testid="gift-modal">
      <div className="bg-white rounded-md border border-line shadow-sh-3 w-[420px] max-w-[95vw] overflow-hidden">
        <div className="px-6 py-4 bg-saffron-50 border-b border-ink-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconGift className="w-5 h-5 text-saffron-600" />
            <div>
              <h2 className="font-arabic font-bold text-lg text-ink-900">ضيافة (مجاناً)</h2>
              <p className="font-arabic text-sm text-ink-500 mt-0.5">{itemName} · قيمتها {fmt(valueCents)}</p>
            </div>
          </div>
          <button onClick={onCancel} className="w-8 h-8 rounded-lg hover:bg-white/60 flex items-center justify-center text-ink-500" aria-label="إغلاق">
            <IconX className="w-4 h-4" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={`min-h-[44px] px-4 rounded-full font-arabic text-sm ${reason === r ? "bg-saffron-600 text-white" : "bg-surface-alt text-ink-700 hover:bg-ink-200"}`}
                data-testid="gift-reason"
              >
                {r}
              </button>
            ))}
          </div>
          {reason === "أخرى" && (
            <input
              type="text"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="اكتب السبب..."
              className="w-full h-12 rounded-sm border-2 border-ink-200 px-4 font-arabic text-sm outline-none focus:border-saffron-600"
              autoFocus
              data-testid="gift-custom-reason"
            />
          )}
          <p className="font-arabic text-xs text-ink-400">يُسجَّل اسمك وسبب الضيافة، وتظهر في تقرير الضيافة.</p>
        </div>
        <div className="px-6 py-4 border-t border-ink-200 flex gap-3">
          <button onClick={onCancel} className="flex-1 h-12 rounded-xl bg-surface-alt text-ink-900 font-arabic font-bold hover:bg-ink-200">رجوع</button>
          <button
            onClick={() => onConfirm(finalReason)}
            disabled={!finalReason}
            className="flex-1 h-12 rounded-xl bg-saffron-600 text-white font-arabic font-bold hover:bg-saffron-700 disabled:opacity-50"
            data-testid="gift-confirm"
          >
            تأكيد الضيافة
          </button>
        </div>
      </div>
    </div>
  );
}
