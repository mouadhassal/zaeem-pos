import { useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { getBusinessMode } from "../../lib/orderService";
import { useAuthStore } from "../../stores/authStore";
import { useBusinessStore } from "../../stores/businessStore";
import { usePrefsStore } from "../../stores/prefsStore";
import { BUSINESS_TYPES, MODULE_INFO, MODULE_KEYS, TYPE_PRESETS, inferType, type BusinessType, type ModuleKey } from "../../lib/businessModules";

/**
 * Settings > نوع النشاط والوحدات (owner only). One app for a restaurant, café, shop or supplier:
 * the type picks a starting set of modules, then each module is switched on or off. A module that
 * is off disappears from the screens and the server refuses its commands (business.rs). Nothing
 * recorded is ever deleted; switching a module back on brings everything back.
 */
export default function BusinessTab() {
  const saved = useBusinessStore((s) => s.businessType);
  const modules = useBusinessStore((s) => s.modules);
  const supplierMode = usePrefsStore((s) => s.supplierMode);
  const [mode, setMode] = useState<{ has_tables: boolean; has_kitchen: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void useBusinessStore.getState().load();
    getBusinessMode().then((m) => setMode({ has_tables: m.has_tables, has_kitchen: m.has_kitchen })).catch(() => setMode({ has_tables: true, has_kitchen: true }));
  }, []);

  const type = mode ? inferType(saved, mode, supplierMode) : null;
  const current: Record<ModuleKey, boolean> = Object.fromEntries(MODULE_KEYS.map((k) => [k, modules?.[k] !== false])) as Record<ModuleKey, boolean>;

  const saveMode = async (next: { has_tables: boolean; has_kitchen: boolean }) => {
    await invoke("update_business_mode_v3", { sessionToken: useAuthStore.getState().token, hasTables: next.has_tables, hasKitchen: next.has_kitchen });
    setMode(next);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await fn();
      setDone(true);
    } catch (e) {
      setError(realErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const pickType = (t: BusinessType) =>
    run(async () => {
      const preset = TYPE_PRESETS[t];
      await saveMode({ has_tables: preset.tables, has_kitchen: preset.kitchen });
      await useBusinessStore.getState().save(t, preset.modules);
      usePrefsStore.getState().setPref("supplierMode", t === "supplier");
    });

  const toggle = (key: "tables" | "kitchen" | ModuleKey, on: boolean) =>
    run(async () => {
      if (!mode || !type) return;
      if (key === "tables") return saveMode({ ...mode, has_tables: on });
      if (key === "kitchen") return saveMode({ ...mode, has_kitchen: on });
      await useBusinessStore.getState().save(type, { ...current, [key]: on });
    });

  const isOn = (key: "tables" | "kitchen" | ModuleKey) =>
    key === "tables" ? !!mode?.has_tables : key === "kitchen" ? !!mode?.has_kitchen : current[key];

  return (
    <div className="space-y-6 max-w-3xl" data-testid="business-tab">
      <div>
        <h2 className="text-lg font-bold text-ink-900 font-arabic">نوع النشاط والوحدات</h2>
        <p className="text-xs text-ink-500 font-arabic mt-1 leading-6">
          اختر نوع نشاطك فيُجهَّز البرنامج بما يناسبه، ثم شغّل أو أوقف أي وحدة كما تريد. الوحدة المتوقفة تختفي من الشاشات ولا يمكن استعمالها، ولا يُحذف شيء مما سُجّل: تشغيلها مجدداً يعيد كل شيء.
        </p>
      </div>

      {error && <p className="text-sm text-red-600 font-arabic" data-testid="business-error">{error}</p>}
      {done && !error && <p className="text-sm text-green-700 font-arabic" data-testid="business-saved">تم الحفظ</p>}

      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="نوع النشاط">
        {BUSINESS_TYPES.map((t) => {
          const active = type === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy || !mode}
              onClick={() => void pickType(t.id)}
              data-testid={`business-type-${t.id}`}
              className={`text-start rounded-md border-2 p-4 transition-colors disabled:opacity-60 ${active ? "border-saffron-600 bg-saffron-50" : "border-ink-200 bg-white hover:border-saffron-400"}`}
            >
              <span className={`block font-arabic font-bold ${active ? "text-saffron-700" : "text-ink-900"}`}>{t.label}</span>
              <span className="block text-xs text-ink-500 font-arabic mt-1">{t.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-ink-400 font-arabic -mt-3">اختيار النوع يضبط الوحدات أدناه على ما يناسبه، ويمكنك بعدها تغيير أي وحدة.</p>

      <div className="bg-white rounded-md border border-ink-200 divide-y divide-ink-100">
        {MODULE_INFO.map((m) => {
          const on = isOn(m.key);
          return (
            <div key={m.key} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <span className="text-sm font-arabic text-ink-900 block">{m.label}</span>
                <span className="text-xs font-arabic text-ink-400">{m.hint}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={m.label}
                disabled={busy || !mode}
                data-testid={`module-${m.key}`}
                onClick={() => void toggle(m.key, !on)}
                dir="ltr"
                className={`inline-flex w-11 h-6 shrink-0 rounded-full items-center px-0.5 transition-colors disabled:opacity-60 ${on ? "bg-saffron-600 justify-end" : "bg-ink-200 justify-start"}`}
              >
                <span className="w-5 h-5 rounded-full bg-white shadow" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
