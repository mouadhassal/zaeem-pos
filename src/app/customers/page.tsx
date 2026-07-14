import { useEffect, useState, useCallback } from "react";
import { getDb } from "../../db";
import { z } from "zod";

interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  birthday: string | null;
  total_orders: number;
  total_spent_cents: number;
  last_order_at: string | null;
  loyalty_points: number;
  last_modified: string;
}

interface OrderRow {
  id: string;
  status: string;
  total_cents: number;
  created_at: string;
  order_type: string;
}

interface FavoriteItem {
  name: string;
  quantity: number;
}

interface CustomerDetail {
  customer: Customer;
  orders: OrderRow[];
  favoriteItems: FavoriteItem[];
  avgOrderValue: number;
}

interface CustomerForm {
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  birthday: string;
}

const emptyForm: CustomerForm = {
  name: "",
  phone: "",
  email: "",
  address: "",
  notes: "",
  birthday: "",
};

const customerSchema = z.object({
  name: z.string().min(1, "الاسم مطلوب").max(100, "أقصى 100 حرف"),
  phone: z.string().min(1, "رقم الهاتف مطلوب").regex(/^[0-9+\-\s()]+$/, "رقم هاتف غير صالح"),
  email: z.string().email("بريد إلكتروني غير صالح").optional().or(z.literal("")),
  address: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  birthday: z.string().optional().default(""),
});

function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("ar-SA", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function formatDateTime(dateStr: string | null): string {
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

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<CustomerForm>(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [detailCustomer, setDetailCustomer] = useState<CustomerDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const filtered = customers.filter((c) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return c.name.toLowerCase().includes(q) || c.phone.includes(q);
  });

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const db = await getDb();
      const rows = await db
        .selectFrom("customers")
        .selectAll()
        .orderBy("name", "asc")
        .execute();
      setCustomers(rows);
    } catch {
      setError("حدث خطأ في تحميل العملاء");
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

  const openEdit = (c: Customer) => {
    setEditId(c.id);
    setForm({
      name: c.name,
      phone: c.phone,
      email: c.email ?? "",
      address: c.address ?? "",
      notes: c.notes ?? "",
      birthday: c.birthday ?? "",
    });
    setFormErrors({});
    setShowModal(true);
  };

  const save = async () => {
    const parsed = customerSchema.safeParse(form);
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
        phone: parsed.data.phone,
        email: parsed.data.email || null,
        address: parsed.data.address || null,
        notes: parsed.data.notes || null,
        birthday: parsed.data.birthday || null,
      };
      if (editId) {
        await db
          .updateTable("customers")
          .set(data)
          .where("id", "=", editId)
          .execute();
      } else {
        await db
          .insertInto("customers")
          .values({
            id: crypto.randomUUID(),
            ...data,
            total_orders: 0,
            total_spent_cents: 0,
            loyalty_points: 0,
            last_order_at: null,
          })
          .execute();
      }
      setShowModal(false);
      await fetchAll();
    } catch (err: any) {
      if (err?.message?.includes("UNIQUE")) {
        setFormErrors({ phone: "رقم الهاتف موجود مسبقاً" });
      } else {
        setFormErrors({ _form: "حدث خطأ في الحفظ" });
      }
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    try {
      const db = await getDb();
      await db.deleteFrom("customers").where("id", "=", deleteId).execute();
      setDeleteId(null);
      await fetchAll();
    } catch {
      setError("حدث خطأ في الحذف");
    }
  };

  const openDetail = async (customer: Customer) => {
    try {
      const db = await getDb();
      const orders = await db
        .selectFrom("orders")
        .select(["id", "status", "total_cents", "created_at", "order_type"])
        .where("customer_phone", "=", customer.phone)
        .orderBy("created_at", "desc")
        .limit(20)
        .execute();

      const items = await db
        .selectFrom("order_items")
        .innerJoin("menu_items", "menu_items.id", "order_items.menu_item_id")
        .innerJoin("orders", "orders.id", "order_items.order_id")
        .select([
          "menu_items.name",
          db.fn.sum<number>("order_items.quantity").as("quantity"),
        ])
        .where("orders.customer_phone", "=", customer.phone)
        .where("order_items.voided", "=", 0)
        .groupBy("menu_items.name")
        .orderBy("quantity", "desc")
        .limit(3)
        .execute();

      const avgValue = customer.total_orders > 0
        ? customer.total_spent_cents / customer.total_orders
        : 0;

      setDetailCustomer({
        customer,
        orders,
        favoriteItems: items.map((i) => ({
          name: i.name,
          quantity: i.quantity ?? 0,
        })),
        avgOrderValue: avgValue,
      });
      setDetailOpen(true);
    } catch {
      setError("حدث خطأ في تحميل التفاصيل");
    }
  };

  const closeDetail = () => {
    setDetailOpen(false);
    setDetailCustomer(null);
  };

  const updateDetailField = async (field: string, value: string) => {
    if (!detailCustomer) return;
    try {
      const db = await getDb();
      await db
        .updateTable("customers")
        .set({ [field]: value || null })
        .where("id", "=", detailCustomer.customer.id)
        .execute();
      setDetailCustomer({
        ...detailCustomer,
        customer: { ...detailCustomer.customer, [field]: value },
      });
    } catch {
      setError("حدث خطأ في التحديث");
    }
  };

  const exportCsv = () => {
    const rows = [
      ["الاسم", "الهاتف", "البريد", "العنوان", "عدد الطلبات", "إجمالي المشتريات", "آخر طلب", "آخر تعديل"],
      ...customers.map((c) => [
        c.name,
        c.phone,
        c.email ?? "",
        c.address ?? "",
        c.total_orders.toString(),
        fromCents(c.total_spent_cents),
        formatDate(c.last_order_at),
        formatDate(c.last_modified),
      ]),
    ];
    const csv = rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `العملاء-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 font-arabic">
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
        <h1 className="text-xl font-bold text-slate-900">قاعدة العملاء</h1>
        <div className="flex gap-2">
          <button
            onClick={openAdd}
            className="h-10 px-4 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors"
          >
            + إضافة عميل
          </button>
          <button
            onClick={exportCsv}
            className="h-10 px-4 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors"
          >
            📤 تصدير
          </button>
        </div>
      </div>

      {/* Search */}
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="ابحث بالاسم أو الهاتف..."
        className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
      />

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-slate-400 font-arabic">
              <th className="text-right p-3 font-medium">الاسم</th>
              <th className="text-right p-3 font-medium">الهاتف</th>
              <th className="text-center p-3 font-medium">عدد الطلبات</th>
              <th className="text-center p-3 font-medium">إجمالي المشتريات</th>
              <th className="text-right p-3 font-medium">آخر طلب</th>
              <th className="text-right p-3 font-medium">آخر تعديل</th>
              <th className="text-center p-3 font-medium">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr
                key={c.id}
                className="border-b border-slate-200 hover:bg-white cursor-pointer"
                onClick={() => openDetail(c)}
              >
                <td className="p-3 font-arabic text-slate-900 font-medium">{c.name}</td>
                <td className="p-3 font-mono text-slate-500" dir="ltr">{c.phone}</td>
                <td className="p-3 text-center font-mono text-slate-900">{c.total_orders}</td>
                <td className="p-3 text-center font-mono text-emerald-600 font-bold">
                  {fromCents(c.total_spent_cents)}
                </td>
                <td className="p-3 font-arabic text-slate-400 text-xs">
                  {formatDateTime(c.last_order_at)}
                </td>
                <td className="p-3 font-arabic text-slate-400 text-xs">
                  {formatDate(c.last_modified)}
                </td>
                <td className="p-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <button
                      onClick={(e) => { e.stopPropagation(); openDetail(c); }}
                      className="p-1.5 rounded-lg text-xs text-emerald-600 hover:bg-emerald-50 transition-colors"
                      title="الطلبات"
                    >
                      👁️
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); openEdit(c); }}
                      className="p-1.5 rounded-lg text-xs text-amber-600 hover:bg-amber-50 transition-colors"
                      title="تعديل"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteId(c.id); }}
                      className="p-1.5 rounded-lg text-xs text-red-500 hover:bg-red-50 transition-colors"
                      title="حذف"
                    >
                      🗑️
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-slate-500 font-arabic">
                  {searchQuery ? "لا توجد نتائج" : "لا يوجد عملاء"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-slate-900">
              {editId ? "تعديل عميل" : "إضافة عميل"}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">الاسم *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  maxLength={100}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                />
                {formErrors.name && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors.name}</p>}
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">رقم الهاتف *</label>
                <input
                  type="text"
                  value={form.phone}
                  onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                  dir="ltr"
                />
                {formErrors.phone && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors.phone}</p>}
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">البريد الإلكتروني</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 text-sm outline-none focus:border-emerald-500"
                  dir="ltr"
                />
                {formErrors.email && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors.email}</p>}
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">العنوان</label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">ملاحظات</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                  rows={3}
                  className="w-full px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">تاريخ الميلاد</label>
                <input
                  type="date"
                  value={form.birthday}
                  onChange={(e) => setForm((p) => ({ ...p, birthday: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                />
              </div>

              {formErrors._form && (
                <p className="text-sm text-red-500 font-arabic">{formErrors._form}</p>
              )}
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowModal(false)}
                className="h-10 px-6 rounded-xl bg-white text-slate-900 font-arabic text-sm hover:bg-slate-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="h-10 px-6 rounded-xl bg-emerald-600 text-white font-arabic text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                {saving ? "جاري الحفظ..." : "حفظ"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-slate-900">تأكيد الحذف</h2>
            <p className="text-sm font-arabic text-slate-500">هل أنت متأكد من حذف هذا العميل؟</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteId(null)}
                className="h-10 px-6 rounded-xl bg-white text-slate-900 font-arabic text-sm hover:bg-slate-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={confirmDelete}
                className="h-10 px-6 rounded-xl bg-red-500 text-white font-arabic text-sm hover:bg-red-600 transition-colors"
              >
                حذف
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Slide-Out Panel */}
      {detailOpen && detailCustomer && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="bg-black/30 flex-1" onClick={closeDetail} />
          <div className="w-full max-w-lg bg-white shadow-2xl h-full overflow-y-auto animate-slide-in-left">
            <div className="p-6 space-y-6">
              {/* Header */}
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold font-arabic text-slate-900">
                  {detailCustomer.customer.name}
                </h2>
                <button
                  onClick={closeDetail}
                  className="p-2 rounded-lg text-slate-500 hover:bg-white transition-colors"
                >
                  ✕
                </button>
              </div>

              {/* Customer Info */}
              <div className="bg-white rounded-2xl p-4 space-y-3">
                <h3 className="font-bold font-arabic text-sm text-slate-900">معلومات العميل</h3>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-arabic w-20">الاسم</span>
                    <input
                      type="text"
                      value={detailCustomer.customer.name}
                      onChange={(e) => updateDetailField("name", e.target.value)}
                      className="flex-1 h-8 px-3 rounded-lg bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-arabic w-20">الهاتف</span>
                    <input
                      type="text"
                      value={detailCustomer.customer.phone}
                      onChange={(e) => updateDetailField("phone", e.target.value)}
                      className="flex-1 h-8 px-3 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                      dir="ltr"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-arabic w-20">البريد</span>
                    <input
                      type="email"
                      value={detailCustomer.customer.email ?? ""}
                      onChange={(e) => updateDetailField("email", e.target.value)}
                      className="flex-1 h-8 px-3 rounded-lg bg-white border border-slate-200 text-slate-900 text-sm outline-none focus:border-emerald-500"
                      dir="ltr"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-arabic w-20">العنوان</span>
                    <input
                      type="text"
                      value={detailCustomer.customer.address ?? ""}
                      onChange={(e) => updateDetailField("address", e.target.value)}
                      className="flex-1 h-8 px-3 rounded-lg bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-emerald-50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-emerald-600 font-mono">
                    {detailCustomer.customer.total_orders}
                  </p>
                  <p className="text-xs text-emerald-700 font-arabic mt-1">الطلبات</p>
                </div>
                <div className="bg-emerald-50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-emerald-600 font-mono">
                    {fromCents(detailCustomer.avgOrderValue)}
                  </p>
                  <p className="text-xs text-emerald-600 font-arabic mt-1">متوسط الفاتورة</p>
                </div>
                <div className="bg-amber-50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-amber-600 font-mono">
                    {detailCustomer.customer.loyalty_points}
                  </p>
                  <p className="text-xs text-amber-700 font-arabic mt-1">نقاط الولاء</p>
                </div>
              </div>

              {/* Favorite Items */}
              <div className="bg-white rounded-2xl p-4 space-y-2 shadow-sm">
                <h3 className="font-bold font-arabic text-sm text-slate-900">الأصناف المفضلة</h3>
                {detailCustomer.favoriteItems.length > 0 ? (
                  <div className="space-y-1">
                    {detailCustomer.favoriteItems.map((item, i) => (
                      <div key={i} className="flex justify-between text-sm">
                        <span className="font-arabic text-slate-900">{item.name}</span>
                        <span className="font-mono text-slate-400">{item.quantity}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 font-arabic">لا توجد طلبات سابقة</p>
                )}
              </div>

              {/* Order History */}
              <div className="bg-white rounded-2xl p-4 space-y-2 shadow-sm">
                <h3 className="font-bold font-arabic text-sm text-slate-900">آخر الطلبات</h3>
                {detailCustomer.orders.length > 0 ? (
                  <div className="space-y-1">
                    {detailCustomer.orders.map((o) => (
                      <div key={o.id} className="flex justify-between items-center text-xs py-1.5 border-b border-slate-200 last:border-0">
                        <span className="font-arabic text-slate-400">
                          {formatDateTime(o.created_at)}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-emerald-600 font-bold">
                            {fromCents(o.total_cents)}
                          </span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-arabic ${
                            o.status === "PAID" ? "bg-emerald-50 text-emerald-600" :
                            o.status === "CANCELLED" ? "bg-red-50 text-red-700" :
                            o.status === "VOIDED" ? "bg-white text-slate-400" :
                            "bg-amber-50 text-amber-700"
                          }`}>
                            {o.status === "PAID" ? "مدفوع" :
                             o.status === "CANCELLED" ? "ملغي" :
                             o.status === "VOIDED" ? "ملغى" :
                             o.status === "PREPARING" ? "قيد التحضير" :
                             o.status === "READY" ? "جاهز" :
                             o.status === "SERVED" ? "مخدم" :
                             o.status === "DRAFT" ? "مسودة" :
                             o.status === "PENDING" ? "معلق" : o.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 font-arabic">لا توجد طلبات</p>
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
