import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { DEFAULT_SETTINGS, describeAbsenceRule, describeLateRule, type EmployeeRow, type PayrollSettings } from "../../lib/payroll";
import AdvancesTab from "./AdvancesTab";
import MonthTab from "./MonthTab";
import PeopleTab from "./PeopleTab";
import RulesPanel from "./RulesPanel";

type Tab = "month" | "people" | "rules" | "advances";

const TABS: { id: Tab; label: string }[] = [
  { id: "month", label: "كشف الشهر" },
  { id: "people", label: "الموظفون" },
  { id: "rules", label: "القواعد" },
  { id: "advances", label: "السلف" },
];

/**
 * Payroll (owner only). The owner sets the rules once (guided, with worked examples), sets each person's pay,
 * and every month reviews each person's payslip, approves it and pays it; paying records the salary as an expense.
 */
export default function PayrollPage() {
  const token = useAuthStore((s) => s.token);
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [tab, setTab] = useState<Tab>("month");
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [s, e] = await Promise.all([
        invoke<PayrollSettings>("get_payroll_settings_v3", { sessionToken: token }),
        invoke<EmployeeRow[]>("list_payroll_employees_v3", { sessionToken: token }),
      ]);
      setSettings(s);
      setEmployees(e);
      // First visit: take the owner straight to the guided setup.
      if (!s.configured) setTab((t) => (t === "month" ? "rules" : t));
    } catch (err) {
      setError(realErrorText(err));
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2" dir="rtl">
        <p className="text-danger font-arabic">{error}</p>
        <button onClick={load} className="text-sm text-saffron-600 hover:text-saffron-700 font-bold font-arabic">إعادة المحاولة</button>
      </div>
    );
  }
  if (!settings) {
    return <div className="flex items-center justify-center h-full text-ink-500 font-arabic">جاري التحميل...</div>;
  }

  return (
    <div className="p-6 space-y-5 overflow-y-auto h-full" dir="rtl" data-testid="payroll-page">
      <div>
        <h1 className="text-xl font-bold text-ink-900 font-arabic">الرواتب</h1>
        <p className="text-sm text-ink-500 font-arabic">أنت تقرر قواعد الخصم والإضافة، والنظام يحسب كشف كل موظف من حضوره.</p>
      </div>

      <div className="flex gap-2 border-b border-ink-200 pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            data-testid={`payroll-tab-${t.id}`}
            className={`px-5 py-2 rounded-t-lg font-arabic font-medium text-sm transition-colors ${tab === t.id ? "bg-saffron-600 text-white" : "text-ink-500 hover:text-saffron-600 hover:bg-white"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "month" && <MonthTab configured={settings.configured} onGoRules={() => setTab("rules")} refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
      {tab === "people" && <PeopleTab employees={employees} onChanged={() => { load(); setRefreshKey((k) => k + 1); }} />}
      {tab === "advances" && <AdvancesTab employees={employees.filter((e) => e.pay)} />}
      {tab === "rules" && (
        <div className="space-y-4">
          {settings.configured && (
            <div className="zc-card p-4 text-sm font-arabic text-ink-900 space-y-1" data-testid="rules-summary">
              <p className="font-bold">القواعد الحالية</p>
              <p>التأخير: {describeLateRule(settings)}</p>
              <p>الغياب: {describeAbsenceRule(settings)}</p>
              <p>الوقت الإضافي: {settings.overtime_rule === "PER_HOUR" ? `يُدفع بنسبة ${settings.overtime_multiplier_pct}%` : "لا يُدفع"}</p>
            </div>
          )}
          <RulesPanel
            key={settings.configured ? "editor" : "wizard"}
            settings={settings.configured ? settings : { ...DEFAULT_SETTINGS, ...settings }}
            wizard={!settings.configured}
            onSaved={(s) => { setSettings(s); setTab("month"); setRefreshKey((k) => k + 1); }}
          />
        </div>
      )}
    </div>
  );
}
