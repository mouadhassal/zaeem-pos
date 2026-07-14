import { Bell, ChevronDown } from "lucide-react";
import { useState } from "react";

interface Props {
  title?: string;
}

export default function TopBar({ title }: Props) {
  const [showNotifs, setShowNotifs] = useState(false);
  const notifs: string[] = [];

  return (
    <header className="h-14 bg-white border-b border-slate-200 flex items-center px-4 gap-3 shrink-0" dir="rtl">
      <span className="text-base font-semibold text-slate-800">{title || "نقطة البيع"}</span>

      <div className="mr-auto flex items-center gap-2">
        <div className="relative">
          <button
            onClick={() => setShowNotifs(!showNotifs)}
            className="relative p-2 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <Bell className="w-[18px] h-[18px]" />
            {notifs.length > 0 && (
              <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                {notifs.length}
              </span>
            )}
          </button>
          {showNotifs && (
            <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-slate-200 rounded-md shadow-lg z-50 py-1">
              {notifs.length === 0 ? (
                <p className="text-sm text-slate-400 px-4 py-3">لا توجد إشعارات</p>
              ) : (
                notifs.map((n, i) => (
                  <p key={i} className="text-sm text-slate-700 px-4 py-2 hover:bg-slate-50">{n}</p>
                ))
              )}
            </div>
          )}
        </div>

        <button className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-50 border border-slate-200 hover:bg-slate-100 transition-colors">
          <div className="w-6 h-6 rounded-sm bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center text-white text-[10px] font-bold">
            م
          </div>
          <span className="text-sm text-slate-700">مدير</span>
          <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
        </button>
      </div>
    </header>
  );
}
