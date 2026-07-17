import { useAuthStore } from "../../stores/authStore";
import { useShiftStore } from "../../stores/shiftStore";
import { usePermissions } from "../../hooks/usePermissions";
import {
  IconLogout as LogOut,
  IconCashRegister, IconToolsKitchen2, IconClipboardList, IconBox,
  IconChartBar, IconUsers, IconClock, IconReceipt2, IconWallet,
  IconTruck, IconBuilding, IconCoin, IconGift, IconRobot, IconWand,
  IconSettings, IconTool,
  type Icon,
} from "@tabler/icons-react";

const ICON_BY_ID: Record<string, Icon> = {
  pos: IconCashRegister,
  kds: IconToolsKitchen2,
  menu: IconClipboardList,
  inventory: IconBox,
  reports: IconChartBar,
  staff: IconUsers,
  shift: IconClock,
  customers: IconReceipt2,
  debt: IconWallet,
  delivery: IconTruck,
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
  const items = navItems.filter((n) => n.allowed);

  return (
    // Narrow icon-rail, not a labelled panel -- it must not compete with the
    // canvas/menu/order-panel for width or introduce its own background tint.
    <aside className="w-[74px] bg-surface flex flex-col shrink-0 border-l border-line items-center" dir="rtl">
      <div className="h-14 flex items-center justify-center border-b border-line shrink-0 w-full">
        <div
          className="w-8 h-8 rounded-[9px] flex items-center justify-center text-white text-sm font-bold shrink-0"
          style={{ backgroundColor: "var(--accent)" }}
        >
          ز
        </div>
      </div>

      <nav className="flex-1 py-2 px-1.5 space-y-1 overflow-y-auto w-full flex flex-col items-center">
        {items.map((item) => {
          const isActive = active === item.id;
          const ItemIcon = ICON_BY_ID[item.id];
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full flex flex-col items-center gap-1 py-2 rounded-[10px] transition-all ${
                isActive
                  ? "bg-accent-soft text-accent-text"
                  : "text-text-3 hover:text-text-2 hover:bg-surface-alt"
              }`}
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
        <div className="p-2 border-t border-line shrink-0 w-full flex flex-col items-center gap-1.5">
          <div
            className="w-8 h-8 rounded-[9px] flex items-center justify-center text-white text-sm font-bold shrink-0 relative"
            style={{ backgroundColor: "var(--accent)" }}
            title={user.name}
          >
            {user.name[0]}
            {activeShiftId && (
              <span className="absolute -bottom-0.5 -left-0.5 w-2 h-2 rounded-full border-2 border-surface" style={{ backgroundColor: "var(--ok)" }} />
            )}
          </div>
          <p className="text-[9px] text-text-muted text-center leading-tight">{roleLabels[user.role] || user.role}</p>
          <button
            onClick={logout}
            aria-label="تسجيل الخروج"
            className="p-1 rounded-[7px] text-text-muted hover:text-danger transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </aside>
  );
}
