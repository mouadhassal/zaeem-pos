import { PRESETS, presetFromMode, type BusinessPreset, type ModeFlags } from "../../lib/businessPreset";
import { usePrefsStore } from "../../stores/prefsStore";

export default function PresetPicker({ mode, onPick, disabled }: { mode: ModeFlags; onPick: (p: BusinessPreset) => void; disabled?: boolean }) {
  const supplierMode = usePrefsStore((s) => s.supplierMode);
  const setPref = usePrefsStore((s) => s.setPref);
  const base = presetFromMode(mode);
  // A supplier has the shop's flags; which of the two it is is this till's choice.
  const current = base === "retail" && supplierMode ? "supplier" : base;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="business-preset-picker">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          disabled={disabled}
          onClick={() => { setPref("supplierMode", p.id === "supplier"); onPick(p.id); }}
          className={`text-right p-4 rounded-md border-2 transition-colors disabled:opacity-50 ${current === p.id ? "border-saffron-600 bg-saffron-50" : "border-ink-200 hover:border-saffron-600"}`}
        >
          <span className="block text-sm font-bold font-arabic text-ink-900">{p.label}</span>
          <span className="block text-xs font-arabic text-ink-400 mt-1">{p.hint}</span>
        </button>
      ))}
    </div>
  );
}
