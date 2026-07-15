import { IconBell as Bell } from "@tabler/icons-react";
import { useAuthStore } from "../../stores/authStore";

export default function TopBar() {
  const user = useAuthStore((s) => s.user);

  return (
    <header className="h-14 bg-surface border-b border-line flex items-center justify-between px-4 shrink-0" dir="rtl">
      <div className="flex items-center gap-3">
        <h1 className="text-base font-medium text-text">نقطة البيع</h1>
      </div>
      <div className="flex items-center gap-3">
        <button className="w-9 h-9 rounded-[10px] flex items-center justify-center text-text-muted hover:bg-surface-alt transition-colors">
          <Bell className="w-[18px] h-[18px]" />
        </button>
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-[9px] flex items-center justify-center text-white text-sm font-bold"
            style={{ backgroundColor: "var(--accent)" }}
          >
            {user?.name?.[0] || "ز"}
          </div>
          <span className="text-sm text-text-2 hidden md:block">{user?.name || "زائر"}</span>
        </div>
      </div>
    </header>
  );
}
