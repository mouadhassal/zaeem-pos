import { useEffect, useState, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { CreditCard, Plus, Search } from "lucide-react";
import { IconGift, IconTag, IconEdit, IconTrash } from "@tabler/icons-react";

interface Customer { id: string; name: string; phone: string; loyalty_points: number; total_orders: number; total_spent_cents: number; }
interface LoyaltyCard { id: string; customer_id: string; card_number: string; points: number; tier: string; issued_at: string; last_used_at: string | null; customer_name: string; customer_phone: string | null; }
interface LoyaltyTx { id: string; card_id: string; points: number; tx_type: string; reference_type: string | null; reference_id: string | null; created_at: string; }

export interface LoyaltyReward {
  id: string;
  tier: string;
  name: string;
  description: string;
  type: "discount_percent" | "free_item" | "fixed_discount" | "points_multiplier";
  value: number;
  menuItemName?: string;
  active: boolean;
  startsAt?: string;
  endsAt?: string;
}

const REWARDS_KEY = "zaeem_loyalty_rewards";

export function loadRewards(): LoyaltyReward[] {
  try {
    const raw = localStorage.getItem(REWARDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveRewards(rewards: LoyaltyReward[]) {
  localStorage.setItem(REWARDS_KEY, JSON.stringify(rewards));
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ar-SA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const TIER_CONFIG: Record<string, { label: string; color: string; icon: string; min_points: number; multiplier: number }> = {
  BRONZE: { label: "برونزي", color: "text-amber-700 bg-amber-50 border-amber-200", icon: "B", min_points: 0, multiplier: 1 },
  SILVER: { label: "فضي", color: "text-ink-600 bg-ink-100 border-ink-300", icon: "S", min_points: 500, multiplier: 1.2 },
  GOLD: { label: "ذهبي", color: "text-yellow-600 bg-yellow-50 border-yellow-300", icon: "G", min_points: 1500, multiplier: 1.5 },
  PLATINUM: { label: "بلاتيني", color: "text-purple-600 bg-purple-50 border-purple-300", icon: "P", min_points: 3000, multiplier: 2 },
};

const TIERS = ["BRONZE", "SILVER", "GOLD", "PLATINUM"];

const REWARD_TYPE_OPTIONS = [
  { value: "discount_percent", label: "خصم %" },
  { value: "free_item", label: "عنصر مجاني" },
  { value: "fixed_discount", label: "خصم ثابت" },
  { value: "points_multiplier", label: "مضاعف نقاط" },
] as const;

const REWARD_TYPE_LABELS: Record<string, string> = {
  discount_percent: "خصم %",
  free_item: "عنصر مجاني",
  fixed_discount: "خصم ثابت",
  points_multiplier: "مضاعف نقاط",
};

const emptyRewardForm = () => ({
  tier: "BRONZE",
  name: "",
  description: "",
  type: "discount_percent" as LoyaltyReward["type"],
  value: 0,
  menuItemName: "",
  active: true,
  startsAt: "",
  endsAt: "",
});

export default function LoyaltyPage() {
  const token = useAuthStore((s) => s.token);
  const [tab, setTab] = useState<"cards" | "transactions" | "rewards">("cards");
  const [cards, setCards] = useState<LoyaltyCard[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [transactions, setTransactions] = useState<LoyaltyTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showIssue, setShowIssue] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [search, setSearch] = useState("");
  const [txCardFilter, setTxCardFilter] = useState("");

  const [rewards, setRewards] = useState<LoyaltyReward[]>(() => loadRewards());
  const [showRewardModal, setShowRewardModal] = useState(false);
  const [editingReward, setEditingReward] = useState<LoyaltyReward | null>(null);
  const [rewardForm, setRewardForm] = useState(emptyRewardForm());
  const [rewardFormError, setRewardFormError] = useState<string | null>(null);

  const fetchCards = useCallback(async () => {
    try {
      const rows = await invoke<LoyaltyCard[]>("list_loyalty_cards_v3", { sessionToken: token });
      setCards(rows);
    } catch (err) { setLoadError(`حدث خطأ في تحميل البطاقات: ${realErrorText(err)}`); }
  }, [token]);

  const fetchCustomers = useCallback(async () => {
    try {
      const rows = await invoke<Customer[]>("list_customers_v3", { sessionToken: token });
      setCustomers(rows);
    } catch (err) { setLoadError(`حدث خطأ في تحميل العملاء: ${realErrorText(err)}`); }
  }, [token]);

  const fetchTransactions = useCallback(async () => {
    try {
      const rows = await invoke<LoyaltyTx[]>("list_loyalty_transactions_v3", { sessionToken: token, cardId: txCardFilter || null });
      setTransactions(rows);
    } catch (err) { setLoadError(`حدث خطأ في تحميل حركات النقاط: ${realErrorText(err)}`); }
  }, [token, txCardFilter]);

  useEffect(() => { setLoading(true); setLoadError(null); Promise.all([fetchCards(), fetchCustomers(), fetchTransactions()]).finally(() => setLoading(false)); }, [fetchCards, fetchCustomers, fetchTransactions]);

  const [issueError, setIssueError] = useState<string | null>(null);
  const [cardUid, setCardUid] = useState("");
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [newCustomerEmail, setNewCustomerEmail] = useState("");
  const [newCustomerError, setNewCustomerError] = useState<string | null>(null);
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  const resetNewCustomerForm = () => {
    setShowNewCustomer(false);
    setNewCustomerName("");
    setNewCustomerPhone("");
    setNewCustomerEmail("");
    setNewCustomerError(null);
  };

  const handleCreateCustomer = async () => {
    setNewCustomerError(null);
    if (!newCustomerName.trim()) {
      setNewCustomerError("الاسم الكامل مطلوب");
      return;
    }
    if (!newCustomerPhone.trim() && !newCustomerEmail.trim()) {
      setNewCustomerError("أدخل رقم الهاتف أو البريد الإلكتروني (واحد منهما على الأقل)");
      return;
    }
    setCreatingCustomer(true);
    try {
      const id = await invoke<string>("create_customer_v3", {
        sessionToken: token,
        name: newCustomerName.trim(),
        phone: newCustomerPhone.trim() || null,
        email: newCustomerEmail.trim() || null,
        address: null, notes: null, birthday: null,
      });
      await fetchCustomers();
      setSelectedCustomer(id);
      resetNewCustomerForm();
    } catch {
      setNewCustomerError("حدث خطأ في إضافة العميل");
    } finally {
      setCreatingCustomer(false);
    }
  };

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

  const openAddReward = () => {
    setEditingReward(null);
    setRewardForm(emptyRewardForm());
    setRewardFormError(null);
    setShowRewardModal(true);
  };

  const openEditReward = (reward: LoyaltyReward) => {
    setEditingReward(reward);
    setRewardForm({
      tier: reward.tier,
      name: reward.name,
      description: reward.description,
      type: reward.type,
      value: reward.value,
      menuItemName: reward.menuItemName ?? "",
      active: reward.active,
      startsAt: reward.startsAt ?? "",
      endsAt: reward.endsAt ?? "",
    });
    setRewardFormError(null);
    setShowRewardModal(true);
  };

  const handleSaveReward = () => {
    setRewardFormError(null);
    if (!rewardForm.name.trim()) {
      setRewardFormError("اسم المكافأة مطلوب");
      return;
    }
    if (rewardForm.value <= 0) {
      setRewardFormError("القيمة يجب أن تكون أكبر من صفر");
      return;
    }
    if (rewardForm.type === "free_item" && !rewardForm.menuItemName.trim()) {
      setRewardFormError("اسم العنصر مطلوب للعنصر المجاني");
      return;
    }

    if (editingReward) {
      const updated = rewards.map((r) =>
        r.id === editingReward.id
          ? {
              ...r,
              tier: rewardForm.tier,
              name: rewardForm.name.trim(),
              description: rewardForm.description.trim(),
              type: rewardForm.type,
              value: rewardForm.value,
              active: rewardForm.active,
              ...(rewardForm.menuItemName.trim() ? { menuItemName: rewardForm.menuItemName.trim() } : {}),
              ...(rewardForm.startsAt ? { startsAt: rewardForm.startsAt } : {}),
              ...(rewardForm.endsAt ? { endsAt: rewardForm.endsAt } : {}),
            }
          : r
      );
      setRewards(updated);
      saveRewards(updated);
    } else {
      const newReward: LoyaltyReward = {
        id: crypto.randomUUID(),
        tier: rewardForm.tier,
        name: rewardForm.name.trim(),
        description: rewardForm.description.trim(),
        type: rewardForm.type,
        value: rewardForm.value,
        active: rewardForm.active,
        ...(rewardForm.menuItemName.trim() ? { menuItemName: rewardForm.menuItemName.trim() } : {}),
        ...(rewardForm.startsAt ? { startsAt: rewardForm.startsAt } : {}),
        ...(rewardForm.endsAt ? { endsAt: rewardForm.endsAt } : {}),
      };
      const updated = [...rewards, newReward];
      setRewards(updated);
      saveRewards(updated);
    }
    setShowRewardModal(false);
  };

  const handleDeleteReward = (id: string) => {
    if (!window.confirm("هل أنت متأكد من حذف هذه المكافأة؟")) return;
    const updated = rewards.filter((r) => r.id !== id);
    setRewards(updated);
    saveRewards(updated);
  };

  const handleToggleRewardActive = (id: string) => {
    const updated = rewards.map((r) => (r.id === id ? { ...r, active: !r.active } : r));
    setRewards(updated);
    saveRewards(updated);
  };

  const rewardsByTier = TIERS.map((t) => ({
    tier: t,
    label: TIER_CONFIG[t].label,
    rewards: rewards.filter((r) => r.tier === t),
  }));

  if (loading) {
    return <div className="flex items-center justify-center h-full text-ink-500 font-arabic">جاري التحميل...</div>;
  }

  if (loadError && cards.length === 0) {
    return <div className="flex items-center justify-center h-full text-red-500 font-arabic">{loadError}</div>;
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
          <div key={t} className={`bg-white rounded-2xl p-4 shadow-sh-1 border ${TIER_CONFIG[t].color} border-opacity-30`}>
            <div className="flex items-center justify-between">
              <span className="w-8 h-8 rounded-lg bg-current/10 flex items-center justify-center text-sm font-bold font-mono">{TIER_CONFIG[t].icon}</span>
              <span className="text-sm font-bold text-ink-900">{TIER_CONFIG[t].label}</span>
            </div>
            <p className="text-xs text-ink-400 mt-2">من {TIER_CONFIG[t].min_points} نقطة</p>
            <p className="text-xs text-ink-400">مضاعف: x{TIER_CONFIG[t].multiplier}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-2 border-b border-ink-200 pb-2">
        {(["cards", "transactions", "rewards"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-5 py-2 rounded-t-lg font-arabic font-medium text-sm transition-colors ${
            tab === t ? "bg-saffron-600 text-white shadow-sh-1" : "text-ink-500 hover:text-saffron-600 hover:bg-white"
          }`}>
            {t === "cards" ? "بطاقات الولاء" : t === "transactions" ? "حركات النقاط" : "المكافآت"}
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
                      <span className="w-6 h-6 rounded-md bg-white/20 flex items-center justify-center text-xs font-bold font-mono">{tier.icon}</span>
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
          <div className="bg-white rounded-2xl shadow-sh-1 overflow-x-auto">
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

      {tab === "rewards" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-ink-500 font-arabic">{rewards.length} مكافأة</span>
            <button onClick={openAddReward} className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors flex items-center gap-2">
              <IconGift className="w-4 h-4" /> إضافة مكافأة
            </button>
          </div>

          {rewardsByTier.map(({ tier, label, rewards: tierRewards }) => (
            <div key={tier} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-7 h-7 rounded-lg bg-current/10 flex items-center justify-center text-xs font-bold font-mono" style={{ color: TIER_CONFIG[tier].color.split(" ")[0] }}>
                  {TIER_CONFIG[tier].icon}
                </span>
                <h3 className="text-sm font-bold text-ink-900 font-arabic">{label}</h3>
                <span className="text-xs text-ink-400 font-arabic">({tierRewards.length})</span>
              </div>
              {tierRewards.length === 0 ? (
                <div className="bg-white rounded-2xl shadow-sh-1 p-4 text-center text-ink-400 text-sm font-arabic">
                  لا توجد مكافآت لهذه الدرجة
                </div>
              ) : (
                <div className="space-y-2">
                  {tierRewards.map((reward) => (
                    <div key={reward.id} className={`bg-white rounded-2xl shadow-sh-1 border border-ink-200 p-4 flex items-center gap-4 ${!reward.active ? "opacity-50" : ""}`}>
                      <div className="w-10 h-10 rounded-xl bg-saffron-100 flex items-center justify-center flex-shrink-0">
                        <IconTag className="w-5 h-5 text-saffron-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-ink-900 font-arabic truncate">{reward.name}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-saffron-100 text-saffron-600 font-arabic font-medium">
                            {REWARD_TYPE_LABELS[reward.type]}
                          </span>
                        </div>
                        {reward.description && (
                          <p className="text-xs text-ink-400 font-arabic mt-1 truncate">{reward.description}</p>
                        )}
                        <div className="flex items-center gap-3 mt-1 text-xs text-ink-400">
                          <span className="font-mono font-bold text-saffron-600">
                            {reward.type === "discount_percent" ? `${reward.value}%` : reward.type === "points_multiplier" ? `x${reward.value}` : `${reward.value}`}
                          </span>
                          {reward.menuItemName && (
                            <span className="font-arabic">العنصر: {reward.menuItemName}</span>
                          )}
                          {reward.startsAt && (
                            <span className="font-arabic">من {reward.startsAt}</span>
                          )}
                          {reward.endsAt && (
                            <span className="font-arabic">إلى {reward.endsAt}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => handleToggleRewardActive(reward.id)}
                          className={`relative w-10 h-6 rounded-full transition-colors ${reward.active ? "bg-saffron-600" : "bg-ink-300"}`}
                          title={reward.active ? "تعطيل" : "تفعيل"}
                        >
                          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${reward.active ? "right-0.5" : "right-[18px]"}`} />
                        </button>
                        <button onClick={() => openEditReward(reward)} className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center transition-colors" title="تعديل">
                          <IconEdit className="w-4 h-4 text-ink-500" />
                        </button>
                        <button onClick={() => handleDeleteReward(reward.id)} className="w-8 h-8 rounded-lg hover:bg-red-50 flex items-center justify-center transition-colors" title="حذف">
                          <IconTrash className="w-4 h-4 text-red-500" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {rewards.length === 0 && (
            <div className="text-center py-12 text-ink-500 font-arabic space-y-2">
              <IconGift className="w-10 h-10 mx-auto text-ink-300" />
              <p>لا توجد مكافآت بعد</p>
              <p className="text-xs text-ink-400">أضف مكافآت لكل درجة ولاء</p>
            </div>
          )}
        </div>
      )}

      {showIssue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">إصدار بطاقة ولاء جديدة</h2>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-arabic text-ink-900">العميل</label>
                {!showNewCustomer && (
                  <button
                    type="button"
                    onClick={() => setShowNewCustomer(true)}
                    className="text-xs font-arabic text-saffron-600 hover:text-saffron-700 font-bold"
                  >
                    + عميل جديد
                  </button>
                )}
              </div>
              {!showNewCustomer && (
                <select value={selectedCustomer} onChange={(e) => setSelectedCustomer(e.target.value)} className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500">
                  <option value="">اختر العميل</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.phone ? ` - ${c.phone}` : ""}</option>
                  ))}
                </select>
              )}
              {showNewCustomer && (
                <div className="bg-ink-50 rounded-xl border border-ink-200 p-3 space-y-2">
                  <input
                    type="text"
                    value={newCustomerName}
                    onChange={(e) => setNewCustomerName(e.target.value)}
                    placeholder="الاسم الكامل *"
                    className="w-full h-10 px-3 rounded-lg bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:ring-2 focus:ring-saffron-500"
                    autoFocus
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    value={newCustomerPhone}
                    onChange={(e) => setNewCustomerPhone(e.target.value)}
                    placeholder="رقم الهاتف"
                    className="w-full h-10 px-3 rounded-lg bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:ring-2 focus:ring-saffron-500"
                    dir="ltr"
                  />
                  <input
                    type="email"
                    value={newCustomerEmail}
                    onChange={(e) => setNewCustomerEmail(e.target.value)}
                    placeholder="البريد الإلكتروني"
                    className="w-full h-10 px-3 rounded-lg bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:ring-2 focus:ring-saffron-500"
                    dir="ltr"
                  />
                  <p className="text-xs text-ink-400 font-arabic">
                    الاسم مطلوب، ويجب إدخال رقم الهاتف أو البريد الإلكتروني (واحد منهما على الأقل)
                  </p>
                  {newCustomerError && <p className="text-xs text-red-500 font-arabic">{newCustomerError}</p>}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={resetNewCustomerForm}
                      className="flex-1 h-9 rounded-lg bg-white text-ink-500 text-sm font-arabic hover:bg-ink-100 transition-colors border border-ink-200"
                    >
                      إلغاء
                    </button>
                    <button
                      type="button"
                      onClick={handleCreateCustomer}
                      disabled={creatingCustomer || !newCustomerName.trim() || (!newCustomerPhone.trim() && !newCustomerEmail.trim())}
                      className="flex-1 h-9 rounded-lg bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
                    >
                      {creatingCustomer ? "جاري الحفظ..." : "حفظ العميل"}
                    </button>
                  </div>
                </div>
              )}
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
              <button onClick={() => { setShowIssue(false); setCardUid(""); setIssueError(null); setSelectedCustomer(""); resetNewCustomerForm(); }} className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {showRewardModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">
              {editingReward ? "تعديل المكافأة" : "إضافة مكافأة جديدة"}
            </h2>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">الدرجة</label>
                <select
                  value={rewardForm.tier}
                  onChange={(e) => setRewardForm((f) => ({ ...f, tier: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-arabic"
                >
                  {TIERS.map((t) => (
                    <option key={t} value={t}>{TIER_CONFIG[t].label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">النوع</label>
                <select
                  value={rewardForm.type}
                  onChange={(e) => setRewardForm((f) => ({ ...f, type: e.target.value as LoyaltyReward["type"] }))}
                  className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-arabic"
                >
                  {REWARD_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-arabic text-ink-900 mb-1">الاسم</label>
              <input
                type="text"
                value={rewardForm.name}
                onChange={(e) => setRewardForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="مثال: خصم 20% للبلاتيني"
                className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-arabic"
              />
            </div>

            <div>
              <label className="block text-sm font-arabic text-ink-900 mb-1">الوصف</label>
              <input
                type="text"
                value={rewardForm.description}
                onChange={(e) => setRewardForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="وصف اختياري"
                className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-arabic"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">
                  {rewardForm.type === "discount_percent" ? "النسبة %" : rewardForm.type === "points_multiplier" ? "المضاعف" : "القيمة"}
                </label>
                <input
                  type="number"
                  min={0}
                  step={rewardForm.type === "discount_percent" || rewardForm.type === "points_multiplier" ? 0.1 : 1}
                  value={rewardForm.value}
                  onChange={(e) => setRewardForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))}
                  className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-mono"
                />
              </div>

              {rewardForm.type === "free_item" && (
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">اسم العنصر</label>
                  <input
                    type="text"
                    value={rewardForm.menuItemName}
                    onChange={(e) => setRewardForm((f) => ({ ...f, menuItemName: e.target.value }))}
                    placeholder="مثال: مشروب غازي"
                    className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-arabic"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">تاريخ البداية</label>
                <input
                  type="date"
                  value={rewardForm.startsAt}
                  onChange={(e) => setRewardForm((f) => ({ ...f, startsAt: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">تاريخ النهاية</label>
                <input
                  type="date"
                  value={rewardForm.endsAt}
                  onChange={(e) => setRewardForm((f) => ({ ...f, endsAt: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-mono"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRewardForm((f) => ({ ...f, active: !f.active }))}
                className={`relative w-10 h-6 rounded-full transition-colors ${rewardForm.active ? "bg-saffron-600" : "bg-ink-300"}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${rewardForm.active ? "right-0.5" : "right-[18px]"}`} />
              </button>
              <span className="text-sm font-arabic text-ink-700">{rewardForm.active ? "نشط" : "معطل"}</span>
            </div>

            {rewardFormError && <p className="text-xs text-red-500 font-arabic">{rewardFormError}</p>}

            <div className="flex gap-2 pt-2">
              <button onClick={handleSaveReward} className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors">
                {editingReward ? "حفظ التعديلات" : "إضافة المكافأة"}
              </button>
              <button onClick={() => setShowRewardModal(false)} className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
