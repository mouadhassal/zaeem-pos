import { useCallback, useEffect, useState } from "react";
import { IconPencil as Pencil, IconTrash as Trash } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { realErrorText } from "../../lib/errors";

interface Area { id: string; name: string; sort_order: number }
interface TableRow { id: string; name: string; area_id?: string | null }

/**
 * Dining areas (الصالة، التراس، الطابق الأول...): the owner names them and puts each table in one.
 * The POS then shows a tab per area above the tables. With no areas the till is unchanged.
 */
export default function AreasSection({ tables, onChanged }: { tables: TableRow[]; onChanged: () => void | Promise<void> }) {
  const token = useAuthStore((s) => s.token);
  const [areas, setAreas] = useState<Area[]>([]);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAreas(await invoke<Area[]>("list_dining_areas_v3", { sessionToken: token }));
    } catch (e) {
      setError(realErrorText(e));
    }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
      await onChanged();
    } catch (e) {
      setError(realErrorText(e));
    }
  };

  const add = () => run(async () => {
    if (!name.trim()) return;
    await invoke("save_dining_area_v3", { sessionToken: token, areaId: null, name: name.trim(), sortOrder: null });
    setName("");
  });
  const rename = (id: string) => run(async () => {
    if (!editingName.trim()) return;
    await invoke("save_dining_area_v3", { sessionToken: token, areaId: id, name: editingName.trim(), sortOrder: null });
    setEditingId(null);
  });
  const remove = (a: Area) => {
    if (!window.confirm(`حذف القسم «${a.name}»؟ تبقى طاولاته بدون قسم.`)) return;
    void run(() => invoke("delete_dining_area_v3", { sessionToken: token, areaId: a.id }));
  };
  const assign = (tableId: string, areaId: string) =>
    run(() => invoke("set_table_area_v3", { sessionToken: token, tableId, areaId: areaId === "" ? null : areaId }));

  const field = "h-9 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600";

  return (
    <div className="space-y-3" data-testid="areas-section">
      <h2 className="text-lg font-bold text-ink-900 font-arabic">أقسام الصالة</h2>
      <div className="bg-white rounded-md p-5 border border-ink-200 space-y-3">
        <p className="text-xs text-ink-400 font-arabic">
          اختياري: قسّم الطاولات إلى أقسام (مثل الصالة والتراس). تظهر الأقسام كتبويبات فوق الطاولات في الكاشير، ولا يُسمح بدمج طاولتين من قسمين مختلفين.
        </p>
        {error && <p className="text-xs text-danger font-arabic">{error}</p>}
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder="اسم القسم الجديد"
            className={`${field} flex-1 h-10`}
            data-testid="area-name"
          />
          <button onClick={() => void add()} disabled={!name.trim()} className="h-10 px-5 rounded-sm bg-saffron-600 text-white text-sm font-bold disabled:opacity-50 shrink-0" data-testid="area-add">إضافة</button>
        </div>

        {areas.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-2 p-2.5 rounded-sm border border-ink-100" data-testid="area-row">
            {editingId === a.id ? (
              <input autoFocus value={editingName} onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void rename(a.id); if (e.key === "Escape") setEditingId(null); }}
                className={`${field} flex-1`} />
            ) : (
              <span className="text-sm font-arabic text-ink-900">{a.name} <span className="text-xs text-ink-400">({tables.filter((t) => t.area_id === a.id).length} طاولة)</span></span>
            )}
            <div className="flex items-center gap-1 shrink-0">
              {editingId === a.id ? (
                <>
                  <button onClick={() => void rename(a.id)} className="h-8 px-3 rounded-sm bg-saffron-600 text-white text-xs font-bold">حفظ</button>
                  <button onClick={() => setEditingId(null)} className="h-8 px-3 rounded-sm text-ink-500 text-xs font-arabic hover:bg-ink-100">إلغاء</button>
                </>
              ) : (
                <>
                  <button onClick={() => { setEditingId(a.id); setEditingName(a.name); }} className="h-8 w-8 rounded-sm flex items-center justify-center text-ink-500 hover:bg-ink-100" title="إعادة تسمية"><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={() => remove(a)} className="h-8 w-8 rounded-sm flex items-center justify-center text-ink-500 hover:bg-danger-soft hover:text-danger" title="حذف"><Trash className="w-3.5 h-3.5" /></button>
                </>
              )}
            </div>
          </div>
        ))}

        {areas.length > 0 && tables.length > 0 && (
          <div className="space-y-1.5 pt-2 border-t border-ink-100">
            <p className="text-sm font-arabic text-ink-500">قسم كل طاولة:</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {tables.map((t) => (
                <label key={t.id} className="flex items-center justify-between gap-2 p-2 rounded-sm border border-ink-100">
                  <span className="text-sm font-arabic text-ink-900">{t.name}</span>
                  <select value={t.area_id ?? ""} onChange={(e) => void assign(t.id, e.target.value)} className={`${field} w-36 text-xs`} data-testid="table-area-select">
                    <option value="">بدون قسم</option>
                    {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
