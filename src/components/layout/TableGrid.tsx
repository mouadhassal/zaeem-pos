interface Table {
  id: string;
  name: string;
  status: "FREE" | "OCCUPIED";
}

interface Props {
  tables: Table[];
  selectedId: string | null;
  onSelect: (table: Table) => void;
}

const STATUS_COLORS = {
  FREE: "bg-white text-ink-500 hover:bg-ink-200",
  OCCUPIED: "bg-saffron-50 text-saffron-600 border border-saffron-200",
};

export default function TableGrid({ tables, selectedId, onSelect }: Props) {
  return (
    <div className="h-20 bg-white border-t border-ink-200 flex items-center gap-2 px-4 overflow-x-auto">
      {tables.map((table) => (
        <button
          key={table.id}
          onClick={() => onSelect(table)}
          className={`min-w-[56px] h-14 rounded-xl flex items-center justify-center text-sm font-bold transition-colors ${
            STATUS_COLORS[table.status]
          } ${selectedId === table.id ? "ring-2 ring-saffron-600" : ""}`}
        >
          {table.name}
        </button>
      ))}

      <div className="mr-auto flex items-center gap-3 text-xs text-ink-500 font-mono pr-4 border-r border-ink-200">
        <span>F1 نقاط البيع</span>
        <span>F2 القائمة</span>
        <span>F3 المخزون</span>
        <span>F4 التقارير</span>
        <span>F5 الإعدادات</span>
      </div>
    </div>
  );
}
