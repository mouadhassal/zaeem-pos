import { useEffect, useState } from "react";
import { useAuthStore } from "../../stores/authStore";
import { useShiftStore } from "../../stores/shiftStore";
import { usePermissions } from "../../hooks/usePermissions";
import { getBusinessMode } from "../../lib/orderService";
import { openMarketplace } from "../../lib/marketplace";
import {
  IconLogout as LogOut,
  IconCashRegister, IconToolsKitchen2, IconClipboardList, IconBox,
  IconChartBar, IconUsers, IconClock, IconReceipt2, IconWallet,
  IconTruck, IconBuilding, IconCoin, IconGift, IconRobot, IconWand,
  IconSettings, IconTool, IconLayoutDashboard, IconShoppingCart, IconCalendar,
  type Icon,
} from "@tabler/icons-react";

const ICON_BY_ID: Record<string, Icon> = {
  dashboard: IconLayoutDashboard,
  pos: IconCashRegister,
  kds: IconToolsKitchen2,
  menu: IconClipboardList,
  inventory: IconBox,
  reports: IconChartBar,
  staff: IconUsers,
  schedule: IconCalendar,
  shift: IconClock,
  customers: IconReceipt2,
  debt: IconWallet,
  delivery: IconTruck,
  marketplace: IconShoppingCart,
  branches: IconBuilding,
  finance: IconCoin,
  loyalty: IconGift,
  ai: IconRobot,
  "ai-onboarding": IconWand,
  settings: IconSettings,
  debug: IconTool,
};

const roleLabels: Record<string, string> = {
  OWNER: "المدير",
  MANAGER: "المشرف",
  CASHIER: "الكاشير",
  KITCHEN: "المطبخ",
};

interface Props {
  active: string;
  onNavigate: (id: string) => void;
}

export default function Sidebar({ active, onNavigate }: Props) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const activeShiftId = useShiftStore((s) => s.activeShiftId);
  const { navItems } = usePermissions();
  // 2026-08-03 "next phase" (see nextphase.md §2): a business with no
  // kitchen has no use for the Kitchen Display System nav item at all.
  const [hasKitchen, setHasKitchen] = useState(true);
  useEffect(() => {
    getBusinessMode().then((m) => setHasKitchen(m.has_kitchen)).catch(() => {});
  }, []);
  const items = navItems
    .filter((n) => n.allowed && (hasKitchen || n.id !== "kds"))
    // MANAGER_NAV/OWNER_NAV (lib/permissions.ts) hardcode "القائمة" (Menu)
    // -- food-service copy that made no sense once has_tables/has_kitchen
    // existed to say "this isn't necessarily a restaurant." A non-food
    // business (pharmacy, retail) still uses this screen for its
    // products/stock, just never sees the Menu framing. Same
    // hasKitchen state this component already fetches for the KDS filter
    // above, just also driving a label swap here instead of a second
    // fetch.
    .map((n) => (n.id === "menu" && !hasKitchen ? { ...n, label: "المنتجات" } : n))
    // 2026-08-13: same gap as "menu" above -- "إعداد القائمة AI" (AI Menu
    // Setup) kept its food-service label regardless of hasKitchen, so a
    // retail/service tenant's first click during onboarding opened a
    // screen literally titled "smart MENU setup" and inviting them to
    // "drag menu photos here."
    .map((n) => (n.id === "ai-onboarding" && !hasKitchen ? { ...n, label: "إعداد المنتجات AI" } : n));

  return (
    // Narrow icon-rail, colored with the brand's brown secondary accent --
    // a deliberate contrast anchor against the light cream canvas, not a
    // decorative tint. Its own contrast-safe tokens (--sidebar-*), not the
    // canvas-tuned --text/--text-2, since this is the one dark surface in
    // an otherwise light app.
    <aside className="w-[74px] flex flex-col shrink-0 items-center" dir="rtl" data-testid="sidebar" style={{ backgroundColor: "var(--sidebar-bg)", color: "var(--sidebar-text-muted)" }}>
      <div className="h-14 flex items-center justify-center border-b shrink-0 w-full" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
        <div
          className="w-8 h-8 rounded-[9px] flex items-center justify-center text-white text-sm font-bold shrink-0"
          style={{ backgroundColor: "var(--accent)" }}
        >
          W
        </div>
      </div>

      <nav className="flex-1 py-2 px-1.5 space-y-1 overflow-y-auto w-full flex flex-col items-center">
        {items.map((item) => {
          const isActive = active === item.id;
          const ItemIcon = ICON_BY_ID[item.id];
          return (
            <button
              key={item.id}
              onClick={() => (item.id === "marketplace" ? openMarketplace() : onNavigate(item.id))}
              data-testid={`sidebar-nav-${item.id}`}
              className="w-full flex flex-col items-center gap-1 py-2 rounded-[10px] transition-all"
              style={{
                backgroundColor: isActive ? "var(--sidebar-active-bg)" : "transparent",
                color: isActive ? "var(--sidebar-active-text)" : "var(--sidebar-text-muted)",
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = "var(--sidebar-text)"; }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.color = "var(--sidebar-text-muted)"; }}
            >
              {ItemIcon
                ? <ItemIcon className="w-5 h-5 shrink-0" stroke={1.75} />
                : <span className="w-5 h-5 shrink-0" />}
              <span className="text-[9px] leading-tight text-center px-0.5">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {user && (
        <div className="p-2 shrink-0 w-full flex flex-col items-center gap-1.5" style={{ borderTop: "1px solid rgba(255,255,255,0.12)" }}>
          <div
            className="w-8 h-8 rounded-[9px] flex items-center justify-center text-white text-sm font-bold shrink-0 relative"
            style={{ backgroundColor: "var(--accent)" }}
            title={user.name}
          >
            {user.name[0]}
            {activeShiftId && (
              <span className="absolute -bottom-0.5 -left-0.5 w-2 h-2 rounded-full border-2" style={{ backgroundColor: "var(--ok)", borderColor: "var(--sidebar-bg)" }} />
            )}
          </div>
          <p className="text-[9px] text-center leading-tight" style={{ color: "var(--sidebar-text-muted)" }}>{roleLabels[user.role] || user.role}</p>
          <button
            onClick={logout}
            aria-label="تسجيل الخروج"
            className="p-1 rounded-[7px] hover:text-danger transition-colors"
            style={{ color: "var(--sidebar-text-muted)" }}
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </aside>
  );
}
