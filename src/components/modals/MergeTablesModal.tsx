import { useState } from "react";

interface Table {
  id: string;
  name: string;
  status: string;
}

interface Props {
  tables: Table[];
  selectedTableId: string | null;
  onMerge: (sourceIds: string[], targetId: string) => void;
  onCancel: () => void;
}

export default function MergeTablesModal({ tables, selectedTableId, onMerge, onCancel }: Props) {
  const [selected, setSelected] = useState<string[]>(
    selectedTableId ? [selectedTableId] : []
  );

  const occupiedTables = tables.filter((t) => t.status === "OCCUPIED");

  const toggleTable = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const targetTable = selected.length > 0 ? selected[0] : null;

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-surface rounded-2xl border border-ink-600 w-[500px]">
        <div className="px-6 py-4 border-b border-ink-200">
          <h2 className="font-arabic font-bold text-lg text-ink-900">دمج الطاولات</h2>
          <p className="font-arabic text-sm text-ink-400 mt-1">
            اختر الطاولات للدمج. الأولى ستكون الطاولة الرئيسية.
          </p>
        </div>

        <div className="p-6">
          {occupiedTables.length < 2 ? (
            <p className="font-arabic text-ink-500 text-center py-8">
              تحتاج طاولتين على الأقل للدمج
            </p>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-3 mb-4">
                {occupiedTables.map((table) => {
                  const idx = selected.indexOf(table.id);
                  return (
                    <button
                      key={table.id}
                      onClick={() => toggleTable(table.id)}
                      className={`h-16 rounded-xl font-arabic font-bold transition-all ${
                        idx === 0
                          ? "bg-accent text-white"
                          : idx > 0
                          ? "bg-surface-alt border-2 border-warn text-warn"
                          : "bg-surface text-ink-500 hover:bg-ink-200"
                      }`}
                    >
                      {table.name}
                      {idx === 0 && (
                        <div className="text-[10px] opacity-80 font-arabic">رئيسية</div>
                      )}
                    </button>
                  );
                })}
              </div>

              {selected.length > 1 && (
                <div className="bg-surface-alt rounded-xl p-3 text-sm font-arabic text-text-2">
                  سيتم دمج {selected.length} طاولات إلى الطاولة الرئيسية
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-ink-200 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 h-12 rounded-xl bg-surface text-ink-900 font-arabic font-bold hover:bg-ink-200"
          >
            إلغاء
          </button>
          <button
            onClick={() => targetTable && onMerge(selected, targetTable)}
            disabled={selected.length < 2}
            className="flex-1 h-12 rounded-xl bg-accent text-white font-arabic font-bold hover:bg-accent-text disabled:opacity-50"
          >
            دمج
          </button>
        </div>
      </div>
    </div>
  );
}
