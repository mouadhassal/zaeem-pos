import { useEffect, useState, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useCurrency } from "../../hooks/useCurrency";
import { CreditCard, Plus, Search } from "lucide-react";
import { IconGift, IconTag, IconPencil, IconTrash } from "@tabler/icons-react";

interface Customer { id: string; name: string; phone: string; loyalty_points: number; total_orders: number; total_spent_cents: number; }
interface LoyaltyCard { id: string; customer_id: string; card_number: string; points: number; tier: string; issued_at: string; last_used_at: string | null; customer_name: string; customer_phone: string | null; }
interface LoyaltyTx { id: string; card_id: string; points: number; tx_type: string; reference_type: string | null; reference_id: string | null; created_at: string; }

interface LoyaltyTier {
  id: string;
  name: string;
  min_points: number;
  points_multiplier: number;
  sort_order: number;
}

interface LoyaltyReward {
  id: string;
  name: string;
  points_cost: number;
  reward_type: "FREE_ITEM" | "DISCOUNT_FIXED" | "DISCOUNT_PERCENT";
  value_cents: number | null;
  value_percent_bps: number | null;
  linked_menu_item_id: string | null;
  is_active: number;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ar-SA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Owner-configured tier NAMES are free text (T2.0: real backend config, no
// longer a hardcoded frontend enum) -- this map is presentational only, for
// the 4 default seeded names; an unrecognized/custom tier name still works,
// it just gets the neutral fallback style below.
const TIER_STYLE: Record<string, { color: string; icon: string }> = {
  BRONZE: { color: "text-amber-700 bg-amber-50 border-amber-200", icon: "B" },
  SILVER: { color: "text-ink-600 bg-ink-100 border-ink-300", icon: "S" },
  GOLD: { color: "text-yellow-600 bg-yellow-50 border-yellow-300", icon: "G" },
  PLATINUM: { color: "text-purple-600 bg-purple-50 border-purple-300", icon: "P" },
};
const DEFAULT_TIER_STYLE = { color: "text-saffron-700 bg-saffron-50 border-saffron-200", icon: "•" };

const REWARD_TYPE_OPTIONS = [
  { value: "FREE_ITEM", label: "عنصر مجاني" },
  { value: "DISCOUNT_FIXED", label: "خصم ثابت" },
  { value: "DISCOUNT_PERCENT", label: "خصم %" },
] as const;

const REWARD_TYPE_LABELS: Record<string, string> = {
  FREE_ITEM: "عنصر مجاني",
  DISCOUNT_FIXED: "خصم ثابت",
  DISCOUNT_PERCENT: "خصم %",
};

const emptyRewardForm = () => ({
  name: "",
  pointsCost: "",
  rewardType: "FREE_ITEM" as LoyaltyReward["reward_type"],
  value: "",
  linkedMenuItemId: "",
});

const emptyTierForm = () => ({ name: "", minPoints: "", multiplier: "1", sortOrder: "0" });

export default function LoyaltyPage() {
  const token = useAuthStore((s) => s.token);
  const { fmt } = useCurrency();
  const [tab, setTab] = useState<"cards" | "transactions" | "rewards" | "tiers">("cards");
  const [cards, setCards] = useState<LoyaltyCard[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [transactions, setTransactions] = useState<LoyaltyTx[]>([]);
  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showIssue, setShowIssue] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [search, setSearch] = useState("");
  const [txCardFilter, setTxCardFilter] = useState("");

  const [showRewardModal, setShowRewardModal] = useState(false);
  const [rewardForm, setRewardForm] = useState(emptyRewardForm());
  const [rewardFormError, setRewardFormError] = useState<string | null>(null);
  const [savingReward, setSavingReward] = useState(false);

  const [showTierModal, setShowTierModal] = useState(false);
  const [editingTier, setEditingTier] = useState<LoyaltyTier | null>(null);
  const [tierForm, setTierForm] = useState(emptyTierForm());
  const [tierFormError, setTierFormError] = useState<string | null>(null);
  const [savingTier, setSavingTier] = useState(false);

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

  const fetchTiers = useCallback(async () => {
    try {
      const rows = await invoke<LoyaltyTier[]>("list_loyalty_tiers_v3", { sessionToken: token });
      setTiers(rows);
    } catch (err) { setLoadError(`حدث خطأ في تحميل الدرجات: ${realErrorText(err)}`); }
  }, [token]);

  const fetchRewards = useCallback(async () => {
    try {
      const rows = await invoke<LoyaltyReward[]>("list_loyalty_rewards_v3", { sessionToken: token });
      setRewards(rows);
    } catch (err) { setLoadError(`حدث خطأ في تحميل المكافآت: ${realErrorText(err)}`); }
  }, [token]);

  useEffect(() => {
    setLoading(true); setLoadError(null);
    Promise.all([fetchCards(), fetchCustomers(), fetchTransactions(), fetchTiers(), fetchRewards()]).finally(() => setLoading(false));
  }, [fetchCards, fetchCustomers, fetchTransactions, fetchTiers, fetchRewards]);

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

  // Mirrors Repo::tier_for exactly: highest tier whose min_points <= points.
  // Sourced from the REAL backend config now, not a hardcoded frontend enum.
  const sortedTiers = [...tiers].sort((a, b) => a.sort_order - b.sort_order);
  const getTierInfo = (points: number) => {
    let best: LoyaltyTier | null = null;
    for (const t of sortedTiers) {
      if (points >= t.min_points && (!best || t.min_points > best.min_points)) best = t;
    }
    return best;
  };
  const nextTierFor = (points: number) => {
    const candidates = sortedTiers.filter((t) => t.min_points > points).sort((a, b) => a.min_points - b.min_points);
    return candidates[0] ?? null;
  };

  const openAddReward = () => {
    setRewardForm(emptyRewardForm());
    setRewardFormError(null);
    setShowRewardModal(true);
  };

  const handleSaveReward = async () => {
    setRewardFormError(null);
    const pointsCost = parseInt(rewardForm.pointsCost, 10);
    if (!rewardForm.name.trim()) { setRewardFormError("اسم المكافأة مطلوب"); return; }
    if (!pointsCost || pointsCost <= 0) { setRewardFormError("تكلفة النقاط يجب أن تكون أكبر من صفر"); return; }

    let valueCents: number | null = null;
    let valuePercentBps: number | null = null;
    if (rewardForm.rewardType === "DISCOUNT_FIXED") {
      valueCents = Math.round(parseFloat(rewardForm.value || "0") * 100);
      if (valueCents <= 0) { setRewardFormError("قيمة الخصم يجب أن تكون أكبر من صفر"); return; }
    } else if (rewardForm.rewardType === "DISCOUNT_PERCENT") {
      valuePercentBps = Math.round(parseFloat(rewardForm.value || "0") * 100);
      if (valuePercentBps <= 0) { setRewardFormError("نسبة الخصم يجب أن تكون أكبر من صفر"); return; }
    }

    setSavingReward(true);
    try {
      await invoke("create_loyalty_reward_v3", {
        sessionToken: token,
        name: rewardForm.name.trim(),
        pointsCost,
        rewardType: rewardForm.rewardType,
        valueCents,
        valuePercentBps,
        linkedMenuItemId: rewardForm.linkedMenuItemId.trim() || null,
      });
      await fetchRewards();
      setShowRewardModal(false);
    } catch (err) {
      setRewardFormError(realErrorText(err));
    } finally {
      setSavingReward(false);
    }
  };

  const handleDeleteReward = async (id: string) => {
    if (!window.confirm("هل أنت متأكد من حذف هذه المكافأة؟")) return;
    try {
      await invoke("delete_loyalty_reward_v3", { sessionToken: token, rewardId: id });
      await fetchRewards();
    } catch (err) {
      setLoadError(`حدث خطأ في حذف المكافأة: ${realErrorText(err)}`);
    }
  };

  const handleToggleRewardActive = async (reward: LoyaltyReward) => {
    try {
      await invoke("set_loyalty_reward_active_v3", { sessionToken: token, rewardId: reward.id, isActive: !reward.is_active });
      await fetchRewards();
    } catch (err) {
      setLoadError(`حدث خطأ في تحديث المكافأة: ${realErrorText(err)}`);
    }
  };

  const openAddTier = () => {
    setEditingTier(null);
    setTierForm(emptyTierForm());
    setTierFormError(null);
    setShowTierModal(true);
  };

  const openEditTier = (t: LoyaltyTier) => {
    setEditingTier(t);
    setTierForm({ name: t.name, minPoints: String(t.min_points), multiplier: String(t.points_multiplier), sortOrder: String(t.sort_order) });
    setTierFormError(null);
    setShowTierModal(true);
  };

  const handleSaveTier = async () => {
    setTierFormError(null);
    const minPoints = parseInt(tierForm.minPoints, 10);
    const multiplier = parseFloat(tierForm.multiplier);
    const sortOrder = parseInt(tierForm.sortOrder, 10) || 0;
    if (!tierForm.name.trim()) { setTierFormError("اسم الدرجة مطلوب"); return; }
    if (isNaN(minPoints) || minPoints < 0) { setTierFormError("الحد الأدنى للنقاط يجب أن يكون صفراً أو أكبر"); return; }
    if (isNaN(multiplier) || multiplier <= 0) { setTierFormError("مضاعف النقاط يجب أن يكون أكبر من صفر"); return; }

    setSavingTier(true);
    try {
      if (editingTier) {
        await invoke("update_loyalty_tier_v3", { sessionToken: token, tierId: editingTier.id, name: tierForm.name.trim(), minPoints, pointsMultiplier: multiplier, sortOrder });
      } else {
        await invoke("create_loyalty_tier_v3", { sessionToken: token, name: tierForm.name.trim(), minPoints, pointsMultiplier: multiplier, sortOrder });
      }
      await fetchTiers();
      setShowTierModal(false);
    } catch (err) {
      setTierFormError(realErrorText(err));
    } finally {
      setSavingTier(false);
    }
  };

  const handleDeleteTier = async (id: string) => {
    if (!window.confirm("هل أنت متأكد من حذف هذه الدرجة؟")) return;
    try {
      await invoke("delete_loyalty_tier_v3", { sessionToken: token, tierId: id });
      await fetchTiers();
    } catch (err) {
      setLoadError(`حدث خطأ في حذف الدرجة: ${realErrorText(err)}`);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-ink-500 font-arabic">جاري التحميل...</div>;
  }

  if (loadError && cards.length === 0 && tiers.length === 0) {
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
        {sortedTiers.map((t) => {
          const style = TIER_STYLE[t.name] ?? DEFAULT_TIER_STYLE;
          return (
            <div key={t.id} className={`bg-white rounded-2xl p-4 shadow-sh-1 border ${style.color} border-opacity-30`}>
              <div className="flex items-center justify-between">
                <span className="w-8 h-8 rounded-lg bg-current/10 flex items-center justify-center text-sm font-bold font-mono">{style.icon}</span>
                <span className="text-sm font-bold text-ink-900">{t.name}</span>
              </div>
              <p className="text-xs text-ink-400 mt-2">من {t.min_points} نقطة</p>
              <p className="text-xs text-ink-400">مضاعف: x{t.points_multiplier}</p>
            </div>
          );
        })}
        {sortedTiers.length === 0 && (
          <div className="col-span-full text-center py-6 text-ink-500 font-arabic bg-white rounded-2xl shadow-sh-1">
            لا توجد درجات ولاء بعد -- أضف واحدة من تبويب "الدرجات"
          </div>
        )}
      </div>

      <div className="flex gap-2 border-b border-ink-200 pb-2">
        {(["cards", "transactions", "rewards", "tiers"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-5 py-2 rounded-t-lg font-arabic font-medium text-sm transition-colors ${
            tab === t ? "bg-saffron-600 text-white shadow-sh-1" : "text-ink-500 hover:text-saffron-600 hover:bg-white"
          }`}>
            {t === "cards" ? "بطاقات الولاء" : t === "transactions" ? "حركات النقاط" : t === "rewards" ? "المكافآت" : "الدرجات"}
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
              const style = tier ? (TIER_STYLE[tier.name] ?? DEFAULT_TIER_STYLE) : DEFAULT_TIER_STYLE;
              const next = nextTierFor(card.points);
              return (
                <div key={card.id} className="bg-white rounded-sm border border-ink-200">
                  <div className="bg-saffron-600 p-4 text-white">
                    <div className="flex items-center justify-between">
                      <CreditCard className="w-5 h-5 opacity-80" />
                      <span className="text-xs opacity-80">{card.card_number}</span>
                    </div>
                    <p className="text-lg font-bold mt-3">{card.customer_name}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="w-6 h-6 rounded-md bg-white/20 flex items-center justify-center text-xs font-bold font-mono">{style.icon}</span>
                      <span className="text-sm">{tier?.name ?? card.tier}</span>
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
                    {next && (
                      <div className="bg-amber-50 text-amber-700 text-xs p-2 rounded-lg font-arabic text-center">
                        يحتاج {next.min_points - card.points} نقطة للوصول لدرجة {next.name}
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

          {rewards.length === 0 ? (
            <div className="text-center py-12 text-ink-500 font-arabic space-y-2 bg-white rounded-2xl shadow-sh-1">
              <IconGift className="w-10 h-10 mx-auto text-ink-300" />
              <p>لا توجد مكافآت بعد</p>
              <p className="text-xs text-ink-400">أضف مكافآت يستبدلها العملاء بنقاطهم</p>
            </div>
          ) : (
            <div className="space-y-2">
              {rewards.map((reward) => (
                <div key={reward.id} className={`bg-white rounded-2xl shadow-sh-1 border border-ink-200 p-4 flex items-center gap-4 ${!reward.is_active ? "opacity-50" : ""}`}>
                  <div className="w-10 h-10 rounded-xl bg-saffron-100 flex items-center justify-center flex-shrink-0">
                    <IconTag className="w-5 h-5 text-saffron-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-ink-900 font-arabic truncate">{reward.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-saffron-100 text-saffron-600 font-arabic font-medium">
                        {REWARD_TYPE_LABELS[reward.reward_type]}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-ink-400">
                      <span className="font-mono font-bold text-saffron-600">{reward.points_cost} نقطة</span>
                      {reward.reward_type === "DISCOUNT_FIXED" && reward.value_cents != null && (
                        <span className="font-arabic">خصم {fmt(reward.value_cents)}</span>
                      )}
                      {reward.reward_type === "DISCOUNT_PERCENT" && reward.value_percent_bps != null && (
                        <span className="font-arabic">خصم {(reward.value_percent_bps / 100).toFixed(1)}%</span>
                      )}
                      {reward.linked_menu_item_id && (
                        <span className="font-arabic">صنف: {reward.linked_menu_item_id}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => handleToggleRewardActive(reward)}
                      role="switch"
                      aria-checked={!!reward.is_active}
                      dir="ltr"
                      className={`relative w-10 h-6 rounded-full transition-colors ${reward.is_active ? "bg-saffron-600" : "bg-ink-300"}`}
                      title={reward.is_active ? "تعطيل" : "تفعيل"}
                    >
                      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${reward.is_active ? "translate-x-4" : "translate-x-0.5"}`} />
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
      )}

      {tab === "tiers" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-ink-500 font-arabic">{tiers.length} درجة</span>
            <button onClick={openAddTier} className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors flex items-center gap-2">
              <Plus className="w-4 h-4" /> إضافة درجة
            </button>
          </div>
          <div className="bg-white rounded-2xl shadow-sh-1 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-ink-400 font-arabic">
                  <th className="text-right p-3 font-medium">الاسم</th>
                  <th className="text-right p-3 font-medium">الحد الأدنى للنقاط</th>
                  <th className="text-right p-3 font-medium">مضاعف النقاط</th>
                  <th className="text-center p-3 font-medium">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {sortedTiers.map((t) => (
                  <tr key={t.id} className="border-b border-ink-200 hover:bg-white">
                    <td className="p-3 font-arabic text-ink-900 font-medium">{t.name}</td>
                    <td className="p-3 font-mono text-ink-900">{t.min_points}</td>
                    <td className="p-3 font-mono text-ink-900">x{t.points_multiplier}</td>
                    <td className="p-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => openEditTier(t)} className="p-1.5 rounded-lg text-xs text-saffron-600 hover:bg-saffron-50 transition-colors" title="تعديل">
                          <IconPencil className="w-4 h-4" />
                        </button>
                        <button onClick={() => handleDeleteTier(t.id)} className="p-1.5 rounded-lg text-xs text-red-500 hover:bg-red-50 transition-colors" title="حذف">
                          <IconTrash className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {sortedTiers.length === 0 && (
                  <tr><td colSpan={4} className="p-6 text-center text-ink-500 font-arabic">لا توجد درجات</td></tr>
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
            <h2 className="text-lg font-bold text-ink-900 font-arabic">إضافة مكافأة جديدة</h2>

            <div>
              <label className="block text-sm font-arabic text-ink-900 mb-1">الاسم</label>
              <input
                type="text"
                value={rewardForm.name}
                onChange={(e) => setRewardForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="مثال: قهوة مجانية"
                className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-arabic"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">تكلفة النقاط</label>
                <input
                  type="number"
                  min={1}
                  value={rewardForm.pointsCost}
                  onChange={(e) => setRewardForm((f) => ({ ...f, pointsCost: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-mono"
                  dir="ltr"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">النوع</label>
                <select
                  value={rewardForm.rewardType}
                  onChange={(e) => setRewardForm((f) => ({ ...f, rewardType: e.target.value as LoyaltyReward["reward_type"] }))}
                  className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-arabic"
                >
                  {REWARD_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {rewardForm.rewardType !== "FREE_ITEM" && (
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">
                  {rewardForm.rewardType === "DISCOUNT_PERCENT" ? "نسبة الخصم %" : "قيمة الخصم"}
                </label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={rewardForm.value}
                  onChange={(e) => setRewardForm((f) => ({ ...f, value: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-mono"
                  dir="ltr"
                />
              </div>
            )}

            {rewardForm.rewardType === "FREE_ITEM" && (
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">معرّف الصنف (اختياري)</label>
                <input
                  type="text"
                  value={rewardForm.linkedMenuItemId}
                  onChange={(e) => setRewardForm((f) => ({ ...f, linkedMenuItemId: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-mono"
                  dir="ltr"
                />
              </div>
            )}

            {rewardFormError && <p className="text-xs text-red-500 font-arabic">{rewardFormError}</p>}

            <div className="flex gap-2 pt-2">
              <button onClick={handleSaveReward} disabled={savingReward} className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50">
                {savingReward ? "جاري الحفظ..." : "إضافة المكافأة"}
              </button>
              <button onClick={() => setShowRewardModal(false)} className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {showTierModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">{editingTier ? "تعديل درجة" : "إضافة درجة جديدة"}</h2>
            <div>
              <label className="block text-sm font-arabic text-ink-900 mb-1">الاسم</label>
              <input type="text" value={tierForm.name} onChange={(e) => setTierForm((f) => ({ ...f, name: e.target.value }))} className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-arabic" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">الحد الأدنى للنقاط</label>
                <input type="number" min={0} value={tierForm.minPoints} onChange={(e) => setTierForm((f) => ({ ...f, minPoints: e.target.value }))} className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-mono" dir="ltr" />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">مضاعف النقاط</label>
                <input type="number" min={0.1} step={0.1} value={tierForm.multiplier} onChange={(e) => setTierForm((f) => ({ ...f, multiplier: e.target.value }))} className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-mono" dir="ltr" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-arabic text-ink-900 mb-1">ترتيب العرض</label>
              <input type="number" value={tierForm.sortOrder} onChange={(e) => setTierForm((f) => ({ ...f, sortOrder: e.target.value }))} className="w-full h-10 px-4 rounded-xl border border-ink-200 text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500 font-mono" dir="ltr" />
            </div>
            {tierFormError && <p className="text-xs text-red-500 font-arabic">{tierFormError}</p>}
            <div className="flex gap-2 pt-2">
              <button onClick={handleSaveTier} disabled={savingTier} className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50">
                {savingTier ? "جاري الحفظ..." : editingTier ? "حفظ التعديلات" : "إضافة الدرجة"}
              </button>
              <button onClick={() => setShowTierModal(false)} className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">إلغاء</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
