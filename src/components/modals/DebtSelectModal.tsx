import { useState, useEffect, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { IconSearch, IconUserPlus, IconX } from "@tabler/icons-react";

interface DebtorRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  balance_cents: number;
  is_active: number;
}

interface Props {
  onClose: () => void;
  onSelect: (id: string, name: string) => void;
}

export default function DebtSelectModal({ onClose, onSelect }: Props) {
  const token = useAuthStore((s) => s.token);
  const [debtors, setDebtors] = useState<DebtorRow[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newError, setNewError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const fetchDebtors = useCallback(async () => {
    try {
      const rows = await invoke<DebtorRow[]>("list_debtors_v3", { sessionToken: token });
      setDebtors(rows.filter((d) => d.is_active !== 0));
    } catch (err) {
      setFetchError(`تعذر تحميل قائمة المدينين: ${realErrorText(err)}`);
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchDebtors(); }, [fetchDebtors]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const filtered = debtors.filter((d) => {
    const q = search.toLowerCase();
    return !q || d.name.toLowerCase().includes(q) || d.phone.includes(q);
  });

  const handleCreate = async () => {
    setNewError(null);
    if (!newName.trim()) { setNewError("الاسم مطلوب"); return; }
    if (!newPhone.trim() && !newEmail.trim()) { setNewError("أدخل الهاتف أو البريد"); return; }
    setCreating(true);
    try {
      const id = await invoke<string>("create_debtor_v3", {
        sessionToken: token, name: newName.trim(),
        phone: newPhone.trim() || null, email: newEmail.trim() || null,
        address: null, notes: null, initialDebtCents: null,
      });
      onSelect(id, newName.trim());
    } catch (err) { setNewError(realErrorText(err)); } finally { setCreating(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-surface rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col" dir="rtl">
        <div className="px-5 py-4 border-b border-line flex items-center justify-between">
          <h2 className="text-base font-bold font-arabic text-text">اختيار مدين</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-surface-alt flex items-center justify-center text-text-muted"><IconX className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-3 border-b border-line">
          <div className="relative">
            <IconSearch className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث بالاسم أو الهاتف..."
              className="w-full h-9 pr-9 pl-3 rounded-lg bg-surface-alt border border-line text-sm font-arabic outline-none focus:border-accent"
              autoFocus
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {loading ? (
            <div className="text-center py-8 text-text-muted font-arabic text-sm">جاري التحميل...</div>
          ) : fetchError ? (
            <div className="text-center py-8 text-danger font-arabic text-sm">{fetchError}</div>
          ) : filtered.length === 0 && !showNew ? (
            <div className="text-center py-8 text-text-muted font-arabic text-sm">
              {search ? "لا توجد نتائج" : "لا يوجد مدينون"}
            </div>
          ) : (
            filtered.map((d) => (
              <button
                key={d.id}
                onClick={() => onSelect(d.id, d.name)}
                className="w-full p-3 rounded-xl border border-line hover:border-accent hover:bg-accent-soft text-right transition-all"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-arabic font-bold text-sm text-text">{d.name}</p>
                    <p className="font-mono text-xs text-text-muted" dir="ltr">{d.phone}</p>
                  </div>
                  <div className="text-left">
                    <p className="text-xs font-arabic text-text-muted">المتبقي</p>
                    <p className={`font-mono font-bold text-sm ${d.balance_cents > 0 ? "text-red-500" : "text-green-500"}`}>
                      {d.balance_cents > 0 ? `-${(d.balance_cents / 100).toLocaleString()}` : "0"}
                    </p>
                  </div>
                </div>
              </button>
            ))
          )}

          {showNew && (
            <div className="border border-accent rounded-xl p-3 space-y-2 bg-accent-soft/30">
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="الاسم *" className="w-full h-9 px-3 rounded-lg bg-surface border border-line text-sm font-arabic outline-none focus:border-accent" autoFocus />
              <input type="text" value={newPhone} onChange={(e) => setNewPhone(e.target.value)}
                placeholder="رقم الهاتف" className="w-full h-9 px-3 rounded-lg bg-surface border border-line text-sm font-mono outline-none focus:border-accent" dir="ltr" />
              <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
                placeholder="البريد الإلكتروني" className="w-full h-9 px-3 rounded-lg bg-surface border border-line text-sm outline-none focus:border-accent" dir="ltr" />
              <p className="text-xs text-text-muted font-arabic">الاسم مطلوب + هاتف أو بريد</p>
              {newError && <p className="text-xs text-red-500 font-arabic">{newError}</p>}
              <div className="flex gap-2">
                <button onClick={() => { setShowNew(false); setNewName(""); setNewPhone(""); setNewEmail(""); setNewError(null); }}
                  className="flex-1 h-9 rounded-lg bg-surface-alt text-text-3 text-sm font-arabic hover:bg-line transition-colors">إلغاء</button>
                <button onClick={handleCreate} disabled={creating || !newName.trim()}
                  className="flex-1 h-9 rounded-lg bg-accent text-white text-sm font-bold hover:bg-accent-text transition-colors disabled:opacity-50">
                  {creating ? "جاري..." : "حفظ"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line">
          {!showNew ? (
            <button onClick={() => setShowNew(true)}
              className="w-full h-10 rounded-xl border-2 border-dashed border-line text-text-3 font-arabic text-sm font-bold hover:border-accent hover:text-accent transition-colors flex items-center justify-center gap-2">
              <IconUserPlus className="w-4 h-4" />
              مدين جديد
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
