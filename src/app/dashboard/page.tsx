import { useMemo, useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { usePermissions } from "../../hooks/usePermissions";
import { useBusinessStore } from "../../stores/businessStore";
import { openPageTab } from "../../lib/deepLink";
import { toLocalDateStr } from "../../lib/dateLocal";
import {
  DASH_TABS, cardDef, periodRange, visibleCardIds, visibleTabs,
  type CardContext, type CustomDays, type DashPeriod, type DashTab,
} from "../../lib/dashboard";
import PeriodPicker from "./PeriodPicker";
import SummaryTab from "./SummaryTab";
import SalesTab from "./SalesTab";
import FinanceTab from "./FinanceTab";
import StockTab from "./StockTab";
import HrTab from "./HrTab";

/**
 * لوحة التحكم: five simple tabs (الخلاصة، المبيعات، المالية، المخزون، الموظفين) over one shared period.
 * Each tab is a few big cards with one plain sentence each; a tap opens the detailed report.
 * A card shows only when the person can open the screen it leads to and the shop uses that part.
 */
export default function DashboardPage() {
  const { navItems } = usePermissions();
  const modules = useBusinessStore((s) => s.modules);
  const hasKitchen = useBusinessStore((s) => s.hasKitchen);

  const [period, setPeriod] = useState<DashPeriod>("today");
  const [custom, setCustom] = useState<CustomDays>(() => {
    const today = toLocalDateStr(new Date());
    return { start: today, end: today };
  });
  const [tab, setTab] = useState<DashTab>("summary");
  const [refreshKey, setRefreshKey] = useState(0);

  const ctx: CardContext = useMemo(
    () => ({ pages: new Set(navItems.filter((n) => n.allowed).map((n) => n.id)), modules, hasKitchen }),
    [navItems, modules, hasKitchen],
  );
  const ids = useMemo(() => visibleCardIds(ctx), [ctx]);
  const tabs = useMemo(() => visibleTabs(ctx), [ctx]);
  const current: DashTab = tabs.includes(tab) ? tab : tabs[0] ?? "summary";
  // The range is worked out again whenever the period changes or the refresh button is pressed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => periodRange(period, new Date(), custom), [period, custom, refreshKey]);

  const show = (id: string) => ids.has(id);
  const open = (id: string) => {
    const def = cardDef(id);
    openPageTab(def.page, def.target);
  };
  const props = { period, range, show, open, refreshKey };

  return (
    <div className="p-6 space-y-5 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink-900 font-arabic">لوحة التحكم</h1>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          className="h-9 px-3 rounded-sm border border-ink-200 bg-white text-sm font-arabic text-ink-500 hover:bg-surface-alt inline-flex items-center gap-1"
          data-testid="dash-refresh"
        >
          <IconRefresh className="w-4 h-4" /> تحديث
        </button>
      </div>

      {tabs.length === 0 ? (
        <div className="py-12 text-center text-ink-500 font-arabic">لا توجد أرقام تناسب صلاحياتك هنا.</div>
      ) : (
        <>
          <div className="flex gap-1.5 flex-wrap border-b border-ink-200 pb-2" role="tablist" data-testid="dash-tabs">
            {DASH_TABS.filter((t) => tabs.includes(t.id)).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={current === t.id}
                onClick={() => setTab(t.id)}
                data-testid={`dash-tab-${t.id}`}
                className={`px-5 py-2 rounded-lg font-arabic text-sm font-bold transition-colors ${current === t.id ? "bg-ink-900 text-white" : "bg-white text-ink-500 hover:bg-ink-200"}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {current === "summary" ? (
            <p className="text-sm text-ink-500 font-arabic">الخلاصة دائماً عن «اليوم» و«هذا الشهر». لرؤية فترة أخرى افتح تبويب المبيعات أو المالية.</p>
          ) : (
            <PeriodPicker period={period} custom={custom} onPeriod={setPeriod} onCustom={setCustom} />
          )}

          {current === "summary" && <SummaryTab show={show} open={open} refreshKey={refreshKey} />}
          {current === "sales" && <SalesTab {...props} />}
          {current === "finance" && <FinanceTab {...props} />}
          {current === "stock" && <StockTab {...props} />}
          {current === "hr" && <HrTab {...props} />}
        </>
      )}
    </div>
  );
}
