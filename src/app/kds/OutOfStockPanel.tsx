import { useEffect, useState } from "react";
import { IconX, IconSearch } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";

interface MenuItemRow {
  id: string;
  name: string;
  is_active: number;
}

/**
 * 2026-08-04: "mark an item out of stock mid-rush." Deliberately not tied
 * to a specific kitchen ticket -- KDS's own order snapshot only carries
 * item NAMES (see KDSItem), not menu_item_id, and more importantly kitchen
 * staff need to 86 an item the moment they realize they're out, not only
 * when a ticket for it happens to come in. A flat, searchable list of the
 * whole menu with one tap per item is the smallest thing that actually
 * works under time pressure.
 */
export function OutOfStockPanel({ token, onClose }: { token: string | null; onClose: () => void }) {
  const [items, setItems] = useState<MenuItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    invoke<MenuItemRow[]>("list_menu_items_v3", { sessionToken: token })
      .then((rows) => setItems(rows.sort((a, b) => a.name.localeCompare(b.name, "ar"))))
      .catch((err) => setError(realErrorText(err)))
      .finally(() => setLoading(false));
  };

  useEffect(load, [token]);

  const toggle = async (item: MenuItemRow) => {
    setPendingId(item.id);
    setError(null);
    const nextActive = !item.is_active;
    try {
      await invoke("toggle_menu_item_availability_v3", { sessionToken: token, itemId: item.id, isActive: nextActive });
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, is_active: nextActive ? 1 : 0 } : i)));
    } catch (err) {
      setError(`تعذر تحديث الصنف: ${realErrorText(err)}`);
    } finally {
      setPendingId(null);
    }
  };

  const filtered = items.filter((i) => i.name.includes(search.trim()));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" dir="rtl">
      <div className="bg-surface rounded-[13px] shadow-sh-3 w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        <div className="p-4 border-b border-line flex items-center justify-between shrink-0">
          <h2 className="text-lg font-bold text-text">توفر الأصناف</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-alt text-text-3">
            <IconX className="w-5 h-5" />
          </button>
        </div>

        <div className="p-3 border-b border-line shrink-0">
          <div className="relative">
            <IconSearch className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-text-3" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث عن صنف..."
              autoFocus
              className="w-full h-10 pr-9 pl-3 rounded-[10px] border border-line text-sm focus:outline-none focus:border-accent"
            />
          </div>
        </div>

        {error && <div className="mx-3 mt-2 bg-danger-soft border border-danger-soft rounded-lg p-2 text-xs text-danger">{error}</div>}

        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {loading && <p className="text-center text-sm text-text-3 py-6">جاري التحميل...</p>}
          {!loading && filtered.length === 0 && <p className="text-center text-sm text-text-3 py-6">لا توجد أصناف مطابقة</p>}
          {filtered.map((item) => (
            <button
              key={item.id}
              onClick={() => toggle(item)}
              disabled={pendingId === item.id}
              className={`w-full flex items-center justify-between px-4 py-2.5 rounded-[10px] text-sm font-bold transition-colors disabled:opacity-50 ${
                item.is_active ? "bg-surface-alt text-text hover:bg-line" : "bg-danger-soft text-danger"
              }`}
            >
              <span>{item.name}</span>
              <span className="text-xs font-medium">{item.is_active ? "متوفر" : "نفد -- اضغط للإعادة"}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
