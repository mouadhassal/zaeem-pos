import { useState } from "react";
import { useAuthStore } from "../../stores/authStore";
import LiveTab from "./LiveTab";
import StatementTab from "./StatementTab";
import SettingsTab from "./SettingsTab";

type Tab = "live" | "statement" | "settings";

const TAB_LABELS: Record<Tab, string> = {
  live: "الطلبات",
  statement: "كشف السائق",
  settings: "السائقون والأجرة",
};

/**
 * Delivery: every delivery order and who has it, each driver's full statement
 * (what he delivered, what he earned, the cash he carries) and settling with
 * him, and the owner's driver list and pay rule.
 */
export default function DeliveryPage() {
  const role = useAuthStore((s) => s.user?.role);
  const [tab, setTab] = useState<Tab>("live");
  // Cashiers run deliveries and settle with drivers; managers and owners also set the pay rule.
  const canManage = role === "OWNER" || role === "MANAGER" || role === "ADMIN";
  const tabs: Tab[] = canManage ? ["live", "statement", "settings"] : ["live", "statement"];

  return (
    <div className="p-6 space-y-5 h-full overflow-y-auto" dir="rtl" data-testid="delivery-page">
      <div className="flex items-center justify-between">
        <h1 className="font-arabic text-xl font-bold text-ink-900">التوصيل</h1>
      </div>

      <div className="flex gap-2 border-b border-ink-200 pb-2">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            data-testid={`delivery-tab-${t}`}
            className={`px-5 py-2 rounded-t-sm font-arabic font-medium text-sm transition-colors ${
              tab === t ? "bg-saffron-600 text-white" : "text-ink-500 hover:text-saffron-600 hover:bg-saffron-50"
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === "live" && <LiveTab />}
      {tab === "statement" && <StatementTab canManage={canManage} />}
      {tab === "settings" && canManage && <SettingsTab />}
    </div>
  );
}
