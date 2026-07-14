import { usePermissions } from "../../hooks/usePermissions";

const ICONS: Record<string, string> = {
  calculator: "M4 2h16a2 2 0 012 2v16a2 2 0 01-2 2H4a2 2 0 01-2-2V4a2 2 0 012-2zm0 4h16M4 10h16M4 14h7M4 18h7",
  users: "M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 7a4 4 0 100-8 4 4 0 000 8zm11 2v6m-3-3h6",
  "book-open": "M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2zM22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z",
  package: "M16.5 9.4l-9-5.19M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12",
  "bar-chart-3": "M18 20V10M12 20V4M6 20v-6",
  "users-round": "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-6 8c0-2.21 4.5-4 6-4s6 1.79 6 4M9 13l-4 3m10-3l4 3",
  "building-2": "M4 22V4a2 2 0 012-2h12a2 2 0 012 2v18M2 22h20M17 7h2v2h-2zM17 11h2v2h-2zM17 15h2v2h-2zM7 7h2v2H7zM7 11h2v2H7zM7 15h2v2H7z",
  wallet: "M21 12V7H5a2 2 0 010-4h14v4M3 5v14a2 2 0 002 2h16v-5M18 12a2 2 0 000 4h4v-4h-4z",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zm7.05 1.05a1 1 0 01.22-1.1l.03-.03a1 1 0 111.41 1.41l-4.24 4.24a1 1 0 01-1.41 0l-.03-.03a1 1 0 01-.22-1.1M12 3v2m0 14v2m-9-9h2m14 0h2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41",
};

interface Props {
  active: string;
  onNavigate: (id: string) => void;
}

export default function RoleBasedSidebar({ active, onNavigate }: Props) {
  const { navItems } = usePermissions();

  return (
    <nav className="w-[68px] bg-white border-l border-slate-200 flex flex-col items-center py-3 gap-1 shrink-0" dir="rtl">
      {navItems.map((item) => {
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`w-14 h-14 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all ${
              isActive
                ? "bg-emerald-50 text-emerald-600 border-r-2 border-emerald-600"
                : "text-slate-500 hover:bg-white hover:text-slate-500"
            } ${item.readOnly ? "opacity-60" : ""}`}
            title={item.label}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d={ICONS[item.icon] || ICONS.calculator} />
            </svg>
            <span className="text-[10px] font-arabic font-medium leading-tight">
              {item.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
