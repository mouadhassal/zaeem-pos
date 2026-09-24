import { PRESETS, presetFromMode, type BusinessPreset, type ModeFlags } from "../../lib/businessPreset";

export default function PresetPicker({ mode, onPick, disabled }: { mode: ModeFlags; onPick: (p: BusinessPreset) => void; disabled?: boolean }) {
  const current = presetFromMode(mode);
  return (
    <div className="grid grid-cols-2 gap-3" data-testid="business-preset-picker">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          disabled={disabled}
          onClick={() => onPick(p.id)}
          className={`text-right p-4 rounded-md border-2 transition-colors disabled:opacity-50 ${current === p.id ? "border-saffron-600 bg-saffron-50" : "border-ink-200 hover:border-saffron-600"}`}
        >
          <span className="block text-sm font-bold font-arabic text-ink-900">{p.label}</span>
          <span className="block text-xs font-arabic text-ink-400 mt-1">{p.hint}</span>
        </button>
      ))}
    </div>
  );
}
