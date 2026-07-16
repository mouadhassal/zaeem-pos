import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "../../stores/authStore";
import { CreditCard, Plus, Search } from "lucide-react";

interface Customer { id: string; name: string; phone: string; loyalty_points: number; total_orders: number; total_spent_cents: number; }
interface LoyaltyCard { id: string; customer_id: string; card_number: string; points: number; tier: string; issued_at: string; last_used_at: string | null; customer_name: string; customer_phone: string | null; }
interface LoyaltyTx { id: string; card_id: string; points: number; tx_type: string; reference_type: string | null; reference_id: string | null; created_at: string; }

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ar-SA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const TIER_CONFIG: Record<string, { label: string; color: string; icon: string; min_points: number; multiplier: number }> = {
  BRONZE: { label: "برونزي", color: "text-amber-700 bg-amber-50 border-amber-200", icon: "🥉", min_points: 0, multiplier: 1 },
  SILVER: { label: "فضي", color: "text-ink-600 bg-ink-100 border-ink-300", icon: "🥈", min_points: 500, multiplier: 1.2 },
  GOLD: { label: "ذهبي", color: "text-yellow-600 bg-yellow-50 border-yellow-300", icon: "🥇", min_points: 1500, multiplier: 1.5 },
  PLATINUM: { label: "بلاتيني", color: "text-purple-600 bg-purple-50 border-purple-300", icon: "💎", min_points: 3000, multiplier: 2 },
};

const TIERS = ["BRONZE", "SILVER", "GOLD", "PLATINUM"];

export default function LoyaltyPage() {
  const token = useAuthStore((s) => s.token);
  const [tab, setTab] = useState<"cards" | "transactions">("cards");
  const [cards, setCards] = useState<LoyaltyCard[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [transactions, setTransactions] = useState<LoyaltyTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [showIssue, setShowIssue] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [search, setSearch] = useState("");
  const [txCardFilter, setTxCardFilter] = useState("");

  const fetchCards = useCallback(async () => {
    try {
      const rows = await invoke<LoyaltyCard[]>("list_loyalty_cards_v3", { sessionToken: token });
      setCards(rows);
    } catch { /* handled */ }
  }, [token]);

  const fetchCustomers = useCallback(async () => {
    try {
      const rows = await invoke<Customer[]>("list_customers_v3", { sessionToken: token });
      setCustomers(rows);
    } catch { /* handled */ }
  }, [token]);

  const fetchTransactions = useCallback(async () => {
    try {
      const rows = await invoke<LoyaltyTx[]>("list_loyalty_transactions_v3", { sessionToken: token, cardId: txCardFilter || null });
      setTransactions(rows);
    } catch { /* handled */ }
  }, [token, txCardFilter]);

  useEffect(() => { setLoading(true); Promise.all([fetchCards(), fetchCustomers(), fetchTransactions()]).finally(() => setLoading(false)); }, [fetchCards, fetchCustomers, fetchTransactions]);

  const [issueError, setIssueError] = useState<string | null>(null);

  // UID keyboard-entry: a physical card scanner is just a keyboard that
  // types the card's UID into this field -- no separate hardware scan path.
  const [cardUid, setCardUid] = useState("");

  const handleIssueCard = async () => {
    if (!selectedCustomer || !cardUid.trim()) return;
    setIssueError(null);
    try {
      await invoke("issue_loyalty_card_v3", { sessionToken: token, customerId: selectedCustomer, cardNumber: cardUid.trim() });
      setShowIssue(false);
      setSelectedCustomer("");
      setCardUid("");
      await fetchCards();
    } catch (err) {
      setIssueError(typeof err === "string" && err.includes("UNIQUE") ? "رقم البطاقة (UID) مستخدم مسبقاً" : "حدث خطأ في إصدار البطاقة");
    }
  };

  const filteredCards = cards.filter((c) =>
    !search || c.customer_name.toLowerCase().includes(search.toLowerCase()) || c.card_number.toLowerCase().includes(search.toLowerCase()) || (c.customer_phone ?? "").includes(search)
  );

  const getTierInfo = (points: number) => {
    for (let i = TIERS.length - 1; i >= 0; i--) {
      if (points >= TIER_CONFIG[TIERS[i]].min_points) return TIER_CONFIG[TIERS[i]];
    }
    return TIER_CONFIG.BRONZE;
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-ink-500 font-arabic">جاري التحميل...</div>;
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">برنامج الولاء</h1>
        <button onClick={() => setShowIssue(true)} className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors flex items-center gap-2">
          <Plus className="w-4 h-4" /> إصدار بطاقة
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {TIERS.map((t) => (
          <div key={t} className={`bg-white rounded-2xl p-4 shadow-sm border ${TIER_CONFIG[t].color} border-opacity-30`}>
            <div className="flex items-center justify-between">
              <span className="text-2xl">{TIER_CONFIG[t].icon}</span>
              <span className="text-sm font-bold text-ink-900">{TIER_CONFIG[t].label}</span>
            </div>
            <p className="text-xs text-ink-400 mt-2">من {TIER_CONFIG[t].min_points} نقطة</p>
            <p className="text-xs text-ink-400">مضاعف: x{TIER_CONFIG[t].multiplier}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-2 border-b border-ink-200 pb-2">
        {(["cards", "transactions"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-5 py-2 rounded-t-lg font-arabic font-medium text-sm transition-colors ${
            tab === t ? "bg-saffron-600 text-white shadow-sm" : "text-ink-500 hover:text-saffron-600 hover:bg-white"
          }`}>
            {t === "cards" ? "بطاقات الولاء" : "حركات النقاط"}
          </button>
        ))}
      </div>

      {tab === "cards" && (
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث عن عميل أو رقم بطاقة..." className="w-full h-10 pr-10 pl-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-arabic" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredCards.map((card) => {
              const tier = getTierInfo(card.points);
              return (
                <div key={card.id} className="bg-white rounded-sm border border-ink-200">
                  <div className="bg-saffron-600 p-4 text-white">
                    <div className="flex items-center justify-between">
                      <CreditCard className="w-5 h-5 opacity-80" />
                      <span className="text-xs opacity-80">{card.card_number}</span>
                    </div>
                    <p className="text-lg font-bold mt-3">{card.customer_name}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-2xl">{tier.icon}</span>
                      <span className="text-sm">{tier.label}</span>
                    </div>
                  </div>
                  <div className="p-4 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-400 font-arabic">النقاط</span>
                      <span className="font-bold text-saffron-600 font-mono">{card.points}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-400 font-arabic">رقم الجوال</span>
                      <span className="font-mono text-ink-900" dir="ltr">{card.customer_phone}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-400 font-arabic">تاريخ الإصدار</span>
                      <span className="text-ink-500">{card.issued_at.slice(0, 10)}</span>
                    </div>
                    {card.last_used_at && (
                      <div className="flex justify-between text-sm">
                        <span className="text-ink-400 font-arabic">آخر استخدام</span>
                        <span className="text-ink-500">{card.last_used_at.slice(0, 10)}</span>
                      </div>
                    )}
                    {card.points >= 500 && card.points < 1500 && (
                      <div className="bg-amber-50 text-amber-700 text-xs p-2 rounded-lg font-arabic text-center">
                        يحتاج {1500 - card.points} نقطة للوصول للدرجة الذهبية
                      </div>
                    )}
                    {card.points >= 1500 && card.points < 3000 && (
                      <div className="bg-purple-50 text-purple-700 text-xs p-2 rounded-lg font-arabic text-center">
                        يحتاج {3000 - card.points} نقطة للوصول للدرجة البلاتينية
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {filteredCards.length === 0 && (
              <div className="col-span-full text-center py-12 text-ink-500 font-arabic">
                لا توجد بطاقات ولاء
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "transactions" && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <select value={txCardFilter} onChange={(e) => setTxCardFilter(e.target.value)} className="h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500">
              <option value="">كل البطاقات</option>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>{c.customer_name} - {c.card_number}</option>
              ))}
            </select>
          </div>
          <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-ink-400 font-arabic">
                  <th className="text-right p-3 font-medium">التاريخ</th>
                  <th className="text-right p-3 font-medium">النوع</th>
                  <th className="text-right p-3 font-medium">النقاط</th>
                  <th className="text-right p-3 font-medium">المرجع</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => {
                  const isEarn = tx.tx_type === "EARN";
                  const isRedeem = tx.tx_type === "REDEEM";
                  return (
                    <tr key={tx.id} className="border-b border-ink-200 hover:bg-white">
                      <td className="p-3 font-mono text-ink-500 text-xs">{formatDateTime(tx.created_at)}</td>
                      <td className="p-3">
                        <span className={`inline-block px-3 py-1 rounded-full text-xs font-arabic font-medium ${
                          isEarn ? "bg-saffron-100 text-saffron-600" : isRedeem ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-700"
                        }`}>
                          {isEarn ? "إضافة" : isRedeem ? "استبدال" : tx.tx_type === "ADJUST" ? "تعديل" : "انتهاء صلاحية"}
                        </span>
                      </td>
                      <td className={`p-3 font-mono font-bold ${isEarn ? "text-saffron-600" : "text-red-500"}`}>
                        {isEarn ? "+" : ""}{tx.points}
                      </td>
                      <td className="p-3 text-ink-600">{tx.reference_type ?? "—"}</td>
                    </tr>
                  );
                })}
                {transactions.length === 0 && (
                  <tr><td colSpan={4} className="p-6 text-center text-ink-500 font-arabic">لا توجد حركات</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showIssue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">إصدار بطاقة ولاء جديدة</h2>
            <div>
              <label className="block text-sm font-arabic text-ink-900 mb-1">العميل</label>
              <select value={selectedCustomer} onChange={(e) => setSelectedCustomer(e.target.value)} className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500">
                <option value="">اختر العميل</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} - {c.phone}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-arabic text-ink-900 mb-1">رقم البطاقة (UID)</label>
              <input
                type="text"
                autoFocus
                value={cardUid}
                onChange={(e) => setCardUid(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && selectedCustomer && cardUid.trim()) handleIssueCard(); }}
                placeholder="امسح البطاقة أو أدخل الرقم يدوياً"
                className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm font-mono outline-none focus:ring-2 focus:ring-saffron-500"
                dir="ltr"
              />
              <p className="text-xs text-ink-400 mt-1 font-arabic">
                الماسح يعمل كلوحة مفاتيح -- امسح البطاقة وسيُملأ الحقل تلقائياً، أو اكتب الرقم يدوياً
              </p>
              {issueError && <p className="text-xs text-red-500 mt-1 font-arabic">{issueError}</p>}
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={handleIssueCard} disabled={!selectedCustomer || !cardUid.trim()} className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-40">إصدار البطاقة</button>
              <button onClick={() => { setShowIssue(false); setCardUid(""); setIssueError(null); }} className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">إلغاء</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
