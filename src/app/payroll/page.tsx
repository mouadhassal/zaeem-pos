import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { DEFAULT_SETTINGS, describeAbsenceRule, describeLateRule, type EmployeeRow, type PayrollAccess, type PayrollSettings } from "../../lib/payroll";
import AdvancesTab from "./AdvancesTab";
import MonthTab from "./MonthTab";
import PeopleTab from "./PeopleTab";
import RulesPanel from "./RulesPanel";

type Tab = "month" | "people" | "rules" | "advances";

const MANAGER_LABEL = { NONE: "لا وصول", PREPARE: "يجهّز الكشف فقط", FULL: "يجهّز ويعتمد ويصرف" } as const;

/**
 * Payroll. The owner sets the rules once (guided, with worked examples), sets each person's pay, decides what
 * branch managers may do, and every month reviews each person's payslip, approves it and pays it (paying records
 * the salary as an expense). A manager the owner switched payroll on for works only on the staff under them in
 * their own branch: they prepare the month, and approve and pay only if the owner allowed it.
 */
export default function PayrollPage() {
  const token = useAuthStore((s) => s.token);
  const [access, setAccess] = useState<PayrollAccess | null>(null);
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [tab, setTab] = useState<Tab>("month");
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setError(null);
      const a = await invoke<PayrollAccess>("get_payroll_access_v3", { sessionToken: token });
      setAccess(a);
      const e = await invoke<EmployeeRow[]>("list_payroll_employees_v3", { sessionToken: token });
      setEmployees(e);
      if (a.can_edit_rules) {
        const s = await invoke<PayrollSettings>("get_payroll_settings_v3", { sessionToken: token });
        setSettings(s);
        // First visit: take the owner straight to the guided setup.
        if (!s.configured) setTab((t) => (t === "month" ? "rules" : t));
      }
    } catch (err) {
      setError(realErrorText(err));
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center" dir="rtl" data-testid="payroll-blocked">
        <p className="text-ink-900 font-arabic max-w-md">{error}</p>
        <button onClick={load} className="text-sm text-saffron-600 hover:text-saffron-700 font-bold font-arabic">إعادة المحاولة</button>
      </div>
    );
  }
  if (!access || (access.can_edit_rules && !settings)) {
    return <div className="flex items-center justify-center h-full text-ink-500 font-arabic">جاري التحميل...</div>;
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "month", label: "كشف الشهر" },
    ...(access.can_edit_rules ? [{ id: "people" as Tab, label: "الموظفون" }, { id: "rules" as Tab, label: "القواعد" }] : []),
    { id: "advances", label: "السلف" },
  ];

  return (
    <div className="p-6 space-y-5 overflow-y-auto h-full" dir="rtl" data-testid="payroll-page">
      <div>
        <h1 className="text-xl font-bold text-ink-900 font-arabic">الرواتب</h1>
        <p className="text-sm text-ink-500 font-arabic">
          {access.is_owner
            ? "أنت تقرر قواعد الخصم والإضافة وما يستطيعه المشرفون، والنظام يحسب كشف كل موظف من حضوره."
            : "كشف رواتب الموظفين الذين تحتك في فرعك. يحدد المالك أجورهم وقواعد الخصم."}
        </p>
        {!access.is_owner && (
          <p className="text-xs text-saffron-700 font-arabic mt-1" data-testid="manager-access-note">
            صلاحيتك: {MANAGER_LABEL[access.manager_access]}
          </p>
        )}
      </div>

      <div className="flex gap-2 border-b border-ink-200 pb-2">
        {tabs.map((t) => (
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

      {tab === "month" && (
        <MonthTab
          configured={settings?.configured ?? true}
          isOwner={access.is_owner}
          canApprove={access.can_approve}
          onGoRules={() => setTab("rules")}
          refreshKey={refreshKey}
          onChanged={() => setRefreshKey((k) => k + 1)}
        />
      )}
      {tab === "people" && access.can_edit_rules && <PeopleTab employees={employees} onChanged={() => { load(); setRefreshKey((k) => k + 1); }} />}
      {tab === "advances" && <AdvancesTab employees={employees.filter((e) => e.pay)} />}
      {tab === "rules" && access.can_edit_rules && settings && (
        <div className="space-y-4">
          {settings.configured && (
            <div className="zc-card p-4 text-sm font-arabic text-ink-900 space-y-1" data-testid="rules-summary">
              <p className="font-bold">القواعد الحالية</p>
              <p>التأخير: {describeLateRule(settings)}</p>
              <p>الغياب: {describeAbsenceRule(settings)}</p>
              <p>الوقت الإضافي: {settings.overtime_rule === "PER_HOUR" ? `يُدفع بنسبة ${settings.overtime_multiplier_pct}%` : "لا يُدفع"}</p>
              <p>المشرفون: {MANAGER_LABEL[settings.manager_access]}</p>
            </div>
          )}
          <RulesPanel
            key={settings.configured ? "editor" : "wizard"}
            settings={settings.configured ? settings : { ...DEFAULT_SETTINGS, ...settings }}
            wizard={!settings.configured}
            onSaved={(s) => { setSettings(s); setTab("month"); setRefreshKey((k) => k + 1); load(); }}
          />
        </div>
      )}
    </div>
  );
}
