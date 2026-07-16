import { useEffect, useState, useCallback } from "react";
import { getDb } from "../../db";
import { z } from "zod";

interface Branch {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  timezone: string;
  currency: string;
  tax_rate_cents: number;
  max_tables: number;
  is_active: number;
}

interface Terminal {
  id: string;
  name: string;
  last_sync: string | null;
  version: string;
  status: string;
}

interface BranchStats {
  todayOrders: number;
  todayRevenue: number;
  terminalCount: number;
  staffCount: number;
}

interface BranchForm {
  name: string;
  address: string;
  city: string;
  phone: string;
  timezone: string;
  currency: string;
  tax_rate_cents: string;
  max_tables: string;
}

const emptyForm: BranchForm = {
  name: "",
  address: "",
  city: "",
  phone: "",
  timezone: "Asia/Riyadh",
  currency: "SAR",
  tax_rate_cents: "1500",
  max_tables: "20",
};

const branchSchema = z.object({
  name: z.string().min(1, "الاسم مطلوب").max(100, "أقصى 100 حرف"),
  address: z.string().optional().default(""),
  city: z.string().optional().default(""),
  phone: z.string().optional().default(""),
  timezone: z.string().min(1, "المنطقة الزمنية مطلوبة"),
  currency: z.string().min(1, "العملة مطلوبة").length(3, "رمز العملة 3 أحرف"),
  tax_rate_cents: z.coerce.number().int().min(0, "يجب أن يكون 0 أو أكثر"),
  max_tables: z.coerce.number().int().min(1, "يجب أن يكون 1 على الأقل"),
});

const TIMEZONES = [
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Kuwait",
  "Asia/Qatar",
  "Asia/Bahrain",
  "Asia/Muscat",
  "Asia/Amman",
  "Africa/Cairo",
  "Asia/Beirut",
  "Africa/Khartoum",
];

const CURRENCIES = ["SYP", "SAR", "AED", "QAR", "KWD", "BHD", "OMR", "JOD", "EGP", "LBP", "SDG"];

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("ar-SA", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

export default function BranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [stats, setStats] = useState<Record<string, BranchStats>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<BranchForm>(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [detailBranch, setDetailBranch] = useState<Branch | null>(null);
  const [detailTerminals, setDetailTerminals] = useState<Terminal[]>([]);
  const [detailStaffCount, setDetailStaffCount] = useState(0);
  const [detailTodaySales, setDetailTodaySales] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const db = await getDb();
      const rows = await db
        .selectFrom("branches")
        .selectAll()
        .orderBy("name", "asc")
        .execute();

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStr = todayStart.toISOString();

      const todayData = await db
        .selectFrom("orders")
        .select([
          db.fn.count<number>("id").as("count"),
          db.fn.sum<number>("total_cents").as("total"),
        ])
        .where("created_at", ">=", todayStr)
        .where("status", "!=", "CANCELLED")
        .where("status", "!=", "VOIDED")
        .executeTakeFirst();

      const terminalCounts = await db
        .selectFrom("terminals")
        .select(["branch_id", db.fn.count<number>("id").as("count")])
        .groupBy("branch_id")
        .execute();

      const terminalMap: Record<string, number> = {};
      for (const t of terminalCounts) {
        terminalMap[t.branch_id] = t.count ?? 0;
      }

      const userCount = (
        await db
          .selectFrom("staff")
          .select(db.fn.count<number>("id").as("count"))
          .executeTakeFirst()
      )?.count ?? 0;

      const statsMap: Record<string, BranchStats> = {};
      for (const b of rows) {
        statsMap[b.id] = {
          todayOrders: todayData?.count ?? 0,
          todayRevenue: (todayData?.total ?? 0) / 100,
          terminalCount: terminalMap[b.id] ?? 0,
          staffCount: userCount,
        };
      }

      setBranches(rows);
      setStats(statsMap);
    } catch {
      setError("حدث خطأ في تحميل الفروع");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const openAdd = () => {
    setEditId(null);
    setForm(emptyForm);
    setFormErrors({});
    setShowModal(true);
  };

  const openEdit = (b: Branch) => {
    setEditId(b.id);
    setForm({
      name: b.name,
      address: b.address ?? "",
      city: b.city ?? "",
      phone: b.phone ?? "",
      timezone: b.timezone,
      currency: b.currency,
      tax_rate_cents: b.tax_rate_cents.toString(),
      max_tables: b.max_tables.toString(),
    });
    setFormErrors({});
    setShowModal(true);
  };

  const save = async () => {
    const parsed = branchSchema.safeParse(form);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as string;
        errs[field] = issue.message;
      }
      setFormErrors(errs);
      return;
    }
    setSaving(true);
    try {
      const db = await getDb();
      const data = {
        name: parsed.data.name,
        address: parsed.data.address || null,
        city: parsed.data.city || null,
        phone: parsed.data.phone || null,
        timezone: parsed.data.timezone,
        currency: parsed.data.currency.toUpperCase(),
        tax_rate_cents: parsed.data.tax_rate_cents,
        max_tables: parsed.data.max_tables,
      };
      if (editId) {
        await db
          .updateTable("branches")
          .set(data)
          .where("id", "=", editId)
          .execute();
      } else {
        await db
          .insertInto("branches")
          .values({ id: crypto.randomUUID(), ...data, is_active: 1 })
          .execute();
      }
      setShowModal(false);
      await fetchAll();
    } catch {
      setFormErrors({ _form: "حدث خطأ في الحفظ" });
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (branch: Branch) => {
    try {
      const db = await getDb();
      await db
        .updateTable("branches")
        .set({ is_active: branch.is_active ? 0 : 1 })
        .where("id", "=", branch.id)
        .execute();
      await fetchAll();
    } catch {
      setError("حدث خطأ في تحديث الحالة");
    }
  };

  const openDetail = async (branch: Branch) => {
    try {
      const db = await getDb();
      const [terminals, userCount, todayData] = await Promise.all([
        db
          .selectFrom("terminals")
          .selectAll()
          .where("branch_id", "=", branch.id)
          .orderBy("name", "asc")
          .execute(),
        db
          .selectFrom("staff")
          .select(db.fn.count<number>("id").as("count"))
          .executeTakeFirst(),
        db
          .selectFrom("orders")
          .select(db.fn.sum<number>("total_cents").as("total"))
          .where("created_at", ">=", new Date().toISOString().slice(0, 10) + "T00:00:00.000Z")
          .where("status", "!=", "CANCELLED")
          .where("status", "!=", "VOIDED")
          .executeTakeFirst(),
      ]);

      setDetailBranch(branch);
      setDetailTerminals(terminals);
      setDetailStaffCount(userCount?.count ?? 0);
      setDetailTodaySales((todayData?.total ?? 0) / 100);
      setDetailOpen(true);
    } catch {
      setError("حدث خطأ في تحميل التفاصيل");
    }
  };

  const closeDetail = () => {
    setDetailOpen(false);
    setDetailBranch(null);
    setDetailTerminals([]);
  };

  const updateDetailField = async (field: string, value: string) => {
    if (!detailBranch) return;
    try {
      const db = await getDb();
      await db
        .updateTable("branches")
        .set({ [field]: value || null })
        .where("id", "=", detailBranch.id)
        .execute();
      setDetailBranch({ ...detailBranch, [field]: value });
    } catch {
      setError("حدث خطأ في التحديث");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-ink-500 font-arabic">
        جاري التحميل...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-500 font-arabic">
        {error}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">إدارة الفروع</h1>
        <button
          onClick={openAdd}
          className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
        >
          + إضافة فرع
        </button>
      </div>

      {/* Branch Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {branches.map((b) => {
          const s = stats[b.id];
          return (
            <div
              key={b.id}
              onClick={() => openDetail(b)}
              className="bg-white rounded-2xl shadow-sm p-5 space-y-4 cursor-pointer hover:shadow-lg transition-shadow"
            >
              {/* Name & Status */}
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-ink-900 font-arabic">{b.name}</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); openEdit(b); }}
                    className="p-1.5 rounded-lg text-xs text-amber-600 hover:bg-amber-50 transition-colors"
                    title="تعديل"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleStatus(b); }}
                    className={`px-3 py-1 rounded-full text-xs font-arabic font-bold ${
                      b.is_active
                        ? "bg-saffron-50 text-saffron-600"
                        : "bg-red-50 text-red-700"
                    }`}
                  >
                    {b.is_active ? "نشط" : "معلق"}
                  </button>
                </div>
              </div>

              {/* Address & Phone */}
              <div className="space-y-1 text-sm text-ink-400 font-arabic">
                {b.address && <p>{b.address}{b.city ? `، ${b.city}` : ""}</p>}
                {b.phone && <p className="font-mono" dir="ltr">{b.phone}</p>}
              </div>

              {/* Stats Row */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-white rounded-xl p-2.5 text-center">
                  <p className="text-lg font-bold text-ink-900 font-mono">{s?.todayOrders ?? 0}</p>
                  <p className="text-[10px] text-ink-500 font-arabic">الطلبات اليوم</p>
                </div>
                <div className="bg-white rounded-xl p-2.5 text-center">
                  <p className="text-lg font-bold text-saffron-600 font-mono">{s?.todayRevenue ?? 0}</p>
                  <p className="text-[10px] text-ink-500 font-arabic">الإيرادات اليوم</p>
                </div>
                <div className="bg-white rounded-xl p-2.5 text-center">
                  <p className="text-lg font-bold text-ink-900 font-mono">{b.max_tables}</p>
                  <p className="text-[10px] text-ink-500 font-arabic">عدد الطاولات</p>
                </div>
                <div className="bg-white rounded-xl p-2.5 text-center">
                  <p className="text-lg font-bold text-ink-900 font-mono">{s?.staffCount ?? 0}</p>
                  <p className="text-[10px] text-ink-500 font-arabic">عدد الموظفين</p>
                </div>
              </div>
            </div>
          );
        })}
        {branches.length === 0 && (
          <div className="col-span-full text-center text-ink-500 font-arabic py-12">
            لا توجد فروع
          </div>
        )}
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">
              {editId ? "تعديل فرع" : "إضافة فرع"}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">الاسم *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  maxLength={100}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                />
                {formErrors.name && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors.name}</p>}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">المدينة</label>
                  <input
                    type="text"
                    value={form.city}
                    onChange={(e) => setForm((p) => ({ ...p, city: e.target.value }))}
                    className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">رقم الهاتف</label>
                  <input
                    type="text"
                    value={form.phone}
                    onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                    className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500"
                    dir="ltr"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">العنوان</label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">المنطقة الزمنية *</label>
                  <select
                    value={form.timezone}
                    onChange={(e) => setForm((p) => ({ ...p, timezone: e.target.value }))}
                    className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                  >
                    {TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                  {formErrors.timezone && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors.timezone}</p>}
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">العملة *</label>
                  <select
                    value={form.currency}
                    onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))}
                    className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  {formErrors.currency && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors.currency}</p>}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">نسبة الضريبة (بالنقاط)</label>
                  <input
                    type="number"
                    min="0"
                    value={form.tax_rate_cents}
                    onChange={(e) => setForm((p) => ({ ...p, tax_rate_cents: e.target.value }))}
                    className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500"
                  />
                  <p className="text-[10px] text-ink-500 mt-0.5 font-arabic">مثال: 1500 = 15%</p>
                  {formErrors.tax_rate_cents && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors.tax_rate_cents}</p>}
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">عدد الطاولات *</label>
                  <input
                    type="number"
                    min="1"
                    value={form.max_tables}
                    onChange={(e) => setForm((p) => ({ ...p, max_tables: e.target.value }))}
                    className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500"
                  />
                  {formErrors.max_tables && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors.max_tables}</p>}
                </div>
              </div>

              {formErrors._form && (
                <p className="text-sm text-red-500 font-arabic">{formErrors._form}</p>
              )}
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowModal(false)}
                className="h-10 px-6 rounded-xl bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="h-10 px-6 rounded-xl bg-saffron-600 text-white font-arabic text-sm hover:bg-saffron-700 transition-colors disabled:opacity-50"
              >
                {saving ? "جاري الحفظ..." : "حفظ"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Slide-Out Panel */}
      {detailOpen && detailBranch && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="bg-black/30 flex-1" onClick={closeDetail} />
          <div className="w-full max-w-lg bg-white shadow-2xl h-full overflow-y-auto animate-slide-in-left">
            <div className="p-6 space-y-6">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-bold font-arabic text-ink-900">
                    {detailBranch.name}
                  </h2>
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-arabic font-bold ${
                      detailBranch.is_active
                        ? "bg-saffron-50 text-saffron-600"
                        : "bg-red-50 text-red-700"
                    }`}
                  >
                    {detailBranch.is_active ? "نشط" : "معلق"}
                  </span>
                </div>
                <button
                  onClick={closeDetail}
                  className="p-2 rounded-lg text-ink-500 hover:bg-white transition-colors"
                >
                  ✕
                </button>
              </div>

              {/* Branch Info (editable) */}
              <div className="bg-white rounded-2xl p-4 space-y-3">
                <h3 className="font-bold font-arabic text-sm text-ink-900">معلومات الفرع</h3>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-500 font-arabic w-20">الاسم</span>
                    <input
                      type="text"
                      value={detailBranch.name}
                      onChange={(e) => updateDetailField("name", e.target.value)}
                      className="flex-1 h-8 px-3 rounded-lg bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-500 font-arabic w-20">العنوان</span>
                    <input
                      type="text"
                      value={detailBranch.address ?? ""}
                      onChange={(e) => updateDetailField("address", e.target.value)}
                      className="flex-1 h-8 px-3 rounded-lg bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-500 font-arabic w-20">المدينة</span>
                    <input
                      type="text"
                      value={detailBranch.city ?? ""}
                      onChange={(e) => updateDetailField("city", e.target.value)}
                      className="flex-1 h-8 px-3 rounded-lg bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-500 font-arabic w-20">الهاتف</span>
                    <input
                      type="text"
                      value={detailBranch.phone ?? ""}
                      onChange={(e) => updateDetailField("phone", e.target.value)}
                      className="flex-1 h-8 px-3 rounded-lg bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500"
                      dir="ltr"
                    />
                  </div>
                </div>
              </div>

              {/* Sales Summary */}
              <div className="bg-saffron-50 rounded-2xl p-4 space-y-2">
                <h3 className="font-bold font-arabic text-sm text-saffron-700">ملخص المبيعات اليوم</h3>
                <p className="text-3xl font-bold text-saffron-600 font-mono">
                  {detailTodaySales.toFixed(2)}
                </p>
                <p className="text-xs text-saffron-500 font-arabic">إجمالي المبيعات</p>
              </div>

              {/* Staff Count */}
              <div className="bg-white rounded-2xl p-4 flex items-center justify-between shadow-sm">
                <span className="font-arabic text-ink-900">عدد الموظفين</span>
                <span className="text-2xl font-bold text-ink-900 font-mono">{detailStaffCount}</span>
              </div>

              {/* Terminals */}
              <div className="bg-white rounded-2xl p-4 space-y-3 shadow-sm">
                <h3 className="font-bold font-arabic text-sm text-ink-900">الأجهزة</h3>
                {detailTerminals.length > 0 ? (
                  <div className="space-y-2">
                    {detailTerminals.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center justify-between py-2 border-b border-ink-200 last:border-0"
                      >
                        <div className="space-y-0.5">
                          <p className="text-sm font-arabic text-ink-900">{t.name}</p>
                          <p className="text-[10px] text-ink-500 font-mono">
                            v{t.version} · آخر مزامنة: {formatDate(t.last_sync)}
                          </p>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-arabic ${
                            t.status === "ACTIVE"
                              ? "bg-saffron-50 text-saffron-600"
                              : t.status === "OFFLINE"
                              ? "bg-amber-50 text-amber-700"
                              : "bg-red-50 text-red-700"
                          }`}
                        >
                          {t.status === "ACTIVE" ? "نشط" : t.status === "OFFLINE" ? "غير متصل" : "معطل"}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-ink-500 font-arabic">لا توجد أجهزة مسجلة</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Slide-in animation style */}
      <style>{`
        @keyframes slideInLeft {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in-left {
          animation: slideInLeft 0.2s ease-out;
        }
      `}</style>
    </div>
  );
}
