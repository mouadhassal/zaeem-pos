import { usePermissions } from "../../hooks/usePermissions";
import { useAuthStore } from "../../stores/authStore";
import {
  Calculator, Clock, Users, BookOpen, Package, BarChart3,
  UsersRound, Building2, Wallet, Settings, Terminal, Truck,
  Award, Bot, LogOut, type LucideIcon,
} from "lucide-react";

const ICON_MAP: Record<string, LucideIcon> = {
  calculator: Calculator,
  clock: Clock,
  users: Users,
  "book-open": BookOpen,
  package: Package,
  "bar-chart-3": BarChart3,
  "users-round": UsersRound,
  "building-2": Building2,
  wallet: Wallet,
  settings: Settings,
  terminal: Terminal,
  truck: Truck,
  award: Award,
  bot: Bot,
};

const SHORTCUT_MAP: Record<string, string> = {
  pos: "F1",
  menu: "F2",
  inventory: "F3",
  reports: "F4",
  settings: "F5",
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
  const { navItems } = usePermissions();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <aside className="w-52 bg-white border-l border-slate-200 flex flex-col shrink-0" dir="rtl">
      <div className="h-14 flex items-center gap-3 px-4 border-b border-slate-100">
        <div className="w-8 h-8 bg-emerald-600 rounded-md flex items-center justify-center">
          <span className="text-white font-bold text-sm">ز</span>
        </div>
        <span className="font-bold text-slate-800 text-lg">زعيم</span>
      </div>

      <nav className="flex-1 py-2 px-2 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = ICON_MAP[item.icon] || Calculator;
          const isActive = active === item.id;
          const shortcut = SHORTCUT_MAP[item.id];
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-all ${
                isActive
                  ? "bg-emerald-50 text-emerald-700 font-semibold border-r-2 border-emerald-500"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
              }`}
              title={item.label}
            >
              <Icon className="w-[18px] h-[18px]" strokeWidth={isActive ? 2.5 : 2} />
              <span className="flex-1 text-right">{item.label}</span>
              {shortcut && (
                <kbd className="hidden xl:inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-400 text-[10px] font-mono">
                  {shortcut}
                </kbd>
              )}
            </button>
          );
        })}
      </nav>

      {user && (
        <div className="p-3 border-t border-slate-100">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-9 h-9 rounded-md bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center text-white font-bold text-sm shrink-0">
              {user.name[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-700 truncate">{user.name}</p>
              <p className="text-[11px] text-slate-400">{roleLabels[user.role] || user.role}</p>
            </div>
            <button
              onClick={logout}
              className="p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
              title="تسجيل الخروج"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
