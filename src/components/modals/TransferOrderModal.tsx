interface Table {
  id: string;
  name: string;
  status: string;
}

interface Props {
  currentTable: { id: string; name: string } | null;
  tables: Table[];
  onTransfer: (toTableId: string) => void;
  onCancel: () => void;
}

export default function TransferOrderModal({ currentTable, tables, onTransfer, onCancel }: Props) {
  const freeTables = tables.filter(
    (t) => t.status === "FREE" && t.id !== currentTable?.id
  );

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-surface rounded-2xl border border-ink-600 w-[450px]">
        <div className="px-6 py-4 border-b border-ink-200">
          <h2 className="font-arabic font-bold text-lg text-ink-900">نقل الطلبية</h2>
          {currentTable && (
            <p className="font-arabic text-sm text-ink-400 mt-1">
              من {currentTable.name}
            </p>
          )}
        </div>

        <div className="p-6">
          {freeTables.length === 0 ? (
            <p className="font-arabic text-ink-500 text-center py-8">
              لا توجد طاولات فارغة للنقل
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {freeTables.map((table) => (
                <button
                  key={table.id}
                  onClick={() => onTransfer(table.id)}
                  className="h-16 rounded-xl bg-surface-alt border-2 border-line text-ink-700 font-arabic font-bold hover:border-ink-400 transition-colors"
                >
                  {table.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-ink-200 flex justify-center">
          <button
            onClick={onCancel}
            className="h-12 px-8 rounded-xl bg-surface text-ink-900 font-arabic font-bold hover:bg-ink-200"
          >
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
