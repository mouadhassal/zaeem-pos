import { useState } from "react";
import { IconArrowsJoin2, IconArmchair2 } from "@tabler/icons-react";

interface TableData {
  id: string;
  name: string;
  status: "FREE" | "OCCUPIED" | "MERGED";
  current_order_id?: string | null;
  area_id?: string | null;
}

interface Props {
  tables: TableData[];
  selectedId: string | null;
  onSelect: (t: TableData) => void;
  onMerge: () => void;
  /** The owner's dining areas. None = the bar is exactly the flat list it always was. */
  areas?: { id: string; name: string }[];
}

const statusColors: Record<string, string> = {
  FREE: "bg-ok",
  OCCUPIED: "bg-danger",
  MERGED: "bg-ink-600",
};

/** The tables to show for the chosen area tab ("all" = every table). */
export function tablesInArea<T extends { area_id?: string | null }>(tables: readonly T[], area: string): T[] {
  return area === "all" ? [...tables] : tables.filter((t) => t.area_id === area);
}

export default function TableBar({ tables, selectedId, onSelect, onMerge, areas = [] }: Props) {
  const [area, setArea] = useState<string>("all");
  if (tables.length === 0) return null;
  // An area that was deleted while its tab was open falls back to "all".
  const current = area !== "all" && areas.some((a) => a.id === area) ? area : "all";
  const shown = tablesInArea(tables, current);

  return (
    <div className="h-16 bg-surface border-t border-ink-200 flex items-center gap-1.5 px-3 overflow-x-auto no-scrollbar shrink-0" dir="rtl">
      <div className="flex items-center gap-1 me-2 text-xs text-ink-400 shrink-0">
        <IconArmchair2 className="w-3.5 h-3.5" />
        <span>الطاولات</span>
      </div>
      {areas.length > 0 && (
        <div className="flex items-center gap-1 me-2 shrink-0" data-testid="area-tabs">
          {[{ id: "all", name: "الكل" }, ...areas].map((a) => (
            <button
              key={a.id}
              onClick={() => setArea(a.id)}
              data-testid={`area-tab-${a.id}`}
              className={`px-3 rounded-full text-xs font-bold transition-colors ${current === a.id ? "bg-accent text-white" : "bg-surface-alt text-text-3 hover:bg-line"}`}
              style={{ minHeight: 36 }}
            >
              {a.name}
            </button>
          ))}
        </div>
      )}
      {shown.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t)}
          className={`relative flex items-center gap-1.5 px-3.5 rounded-sm text-xs font-medium transition-colors shrink-0 ${
            selectedId === t.id
              ? "bg-ink-900 text-white border border-ink-900"
              : "bg-surface text-ink-600 border border-ink-200 hover:bg-ink-50"
          }`}
          style={{ minHeight: 44 }}
        >
          <span className={`w-2 h-2 rounded-sm ${statusColors[t.status]}`} />
          <span>{t.name}</span>
        </button>
      ))}
      <button
        onClick={onMerge}
        className="flex items-center gap-1 px-3.5 rounded-sm text-xs font-medium bg-surface text-ink-600 border border-ink-200 hover:bg-ink-50 transition-colors shrink-0"
        style={{ minHeight: 44 }}
      >
        <IconArrowsJoin2 className="w-3.5 h-3.5" />
        دمج
      </button>
    </div>
  );
}
