import { IconArrowsJoin2, IconArmchair2 } from "@tabler/icons-react";

interface TableData {
  id: string;
  name: string;
  status: "FREE" | "OCCUPIED" | "MERGED";
  current_order_id?: string | null;
}

interface Props {
  tables: TableData[];
  selectedId: string | null;
  onSelect: (t: TableData) => void;
  onMerge: () => void;
}

const statusColors: Record<string, string> = {
  FREE: "bg-ok",
  OCCUPIED: "bg-danger",
  MERGED: "bg-ink-600",
};

export default function TableBar({ tables, selectedId, onSelect, onMerge }: Props) {
  if (tables.length === 0) return null;

  return (
    <div className="h-14 bg-surface border-t border-ink-200 flex items-center gap-1 px-3 overflow-x-auto no-scrollbar shrink-0" dir="rtl">
      <div className="flex items-center gap-1 ml-2 text-xs text-ink-400 shrink-0">
        <IconArmchair2 className="w-3.5 h-3.5" />
        <span>الطاولات</span>
      </div>
      {tables.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t)}
          className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-xs font-medium transition-colors shrink-0 ${
            selectedId === t.id
              ? "bg-ink-900 text-white border border-ink-900"
              : "bg-surface text-ink-600 border border-ink-200 hover:bg-ink-50"
          }`}
        >
          <span className={`w-2 h-2 rounded-sm ${statusColors[t.status]}`} />
          <span>{t.name}</span>
        </button>
      ))}
      <button
        onClick={onMerge}
        className="flex items-center gap-1 px-3 py-1.5 rounded-sm text-xs font-medium bg-surface text-ink-600 border border-ink-200 hover:bg-ink-50 transition-colors shrink-0"
      >
        <IconArrowsJoin2 className="w-3.5 h-3.5" />
        دمج
      </button>
    </div>
  );
}
