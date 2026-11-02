import { useState, type ReactNode } from "react";
import { IconInfoCircle, IconX } from "@tabler/icons-react";

/** A small "what does this mean?" note: a short line always visible, the longer explanation on demand. */
export function Hint({ summary, children }: { summary?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs font-arabic text-ink-500 space-y-1">
      {summary && <p>{summary}</p>}
      {children && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 text-saffron-600 hover:text-saffron-700 font-bold">
            <IconInfoCircle className="w-3.5 h-3.5" />
            {open ? "إخفاء الشرح" : "اشرح لي"}
          </button>
          {open && <div className="rounded-md bg-surface-alt border border-ink-200 p-3 space-y-1.5 text-ink-700">{children}</div>}
        </>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" dir="rtl">
      <div className={`bg-white rounded-md shadow-xl w-full ${wide ? "max-w-4xl" : "max-w-lg"} mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold font-arabic text-ink-900">{title}</h2>
          <button onClick={onClose} aria-label="إغلاق" className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center text-ink-500 shrink-0">
            <IconX className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-sm font-arabic text-ink-900">{label}</span>
      {children}
      {hint && <span className="block text-[11px] font-arabic text-ink-400">{hint}</span>}
    </label>
  );
}

export const inputCls = "w-full h-10 px-3 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500";
export const btnPrimary = "h-10 px-5 rounded-sm bg-saffron-600 text-white text-sm font-bold font-arabic hover:bg-saffron-700 transition-colors disabled:opacity-40";
export const btnGhost = "h-10 px-5 rounded-sm border border-ink-200 text-ink-700 text-sm font-arabic hover:bg-white transition-colors disabled:opacity-40";

/** Choice cards: each option has a title and a plain explanation, so the owner knows what he is picking. */
export function ChoiceCards<T extends string>({ value, onChange, options, testId }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; title: string; text: string }[];
  testId?: string;
}) {
  return (
    <div className="space-y-2" data-testid={testId}>
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          onClick={() => onChange(o.value)}
          data-testid={testId ? `${testId}-${o.value}` : undefined}
          className={`w-full text-right rounded-md border p-3 transition-colors ${value === o.value ? "border-saffron-500 bg-saffron-50" : "border-ink-200 bg-white hover:bg-surface-alt"}`}
        >
          <span className="block text-sm font-bold font-arabic text-ink-900">{o.title}</span>
          <span className="block text-xs font-arabic text-ink-500 mt-0.5">{o.text}</span>
        </button>
      ))}
    </div>
  );
}
