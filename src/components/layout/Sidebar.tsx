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
    <aside className="w-[152px] bg-surface flex flex-col shrink-0 border-l border-line" dir="rtl">
      <div className="h-14 flex items-center gap-2 px-3 border-b border-line shrink-0">
        <div
          className="w-7 h-7 rounded-[9px] flex items-center justify-center text-white text-sm font-bold shrink-0"
          style={{ backgroundColor: "var(--accent)" }}
        >
          ز
        </div>
        <span className="font-bold text-text text-base">زعيم</span>
      </div>

      <nav className="flex-1 py-2 px-2 space-y-0.5 overflow-y-auto">
        {items.map((item, i) => {
          const isActive = active === item.id;
          const shortcut = i < 9 ? `F${i + 1}` : "";
          const ItemIcon = ICON_BY_ID[item.id];
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] text-sm transition-all ${
                isActive
                  ? "bg-accent-soft text-accent-text font-semibold"
                  : "text-text-3 hover:text-text-2"
              }`}
            >
              {ItemIcon
                ? <ItemIcon className="w-4 h-4 shrink-0" stroke={1.75} />
                : <span className="w-4 h-4 shrink-0" />}
              <span className="flex-1 text-right text-sm">{item.label}</span>
              {shortcut && (
                <kbd className="text-[9px] text-text-muted font-mono tabular">{shortcut}</kbd>
              )}
            </button>
          );
        })}
      </nav>

      {user && (
        <div className="p-2.5 border-t border-line shrink-0">
          <div className="flex items-center gap-2.5 px-2 py-2">
            <div
              className="w-8 h-8 rounded-[9px] flex items-center justify-center text-white text-sm font-bold shrink-0"
              style={{ backgroundColor: "var(--accent)" }}
            >
              {user.name[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text truncate">{user.name}</p>
              <p className="text-[10px] text-text-muted">{roleLabels[user.role] || user.role}</p>
              {activeShiftId && (
                <p className="text-[9px] text-ok">وردية نشطة</p>
              )}
            </div>
            <button
              onClick={logout}
              className="p-1 rounded-[7px] text-text-muted hover:text-danger transition-colors"
              title="تسجيل الخروج"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
