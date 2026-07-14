import { useEffect, useState, useCallback } from "react";
import { getDb } from "../../db";
import { z } from "zod";

interface Category {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
  image_path: string | null;
  is_active: number;
}

interface MenuItem {
  id: string;
  name: string;
  price_cents: number;
  cost_cents: number;
  category_id: string;
  image_path: string | null;
  description: string | null;
  barcode: string | null;
  is_active: number;
}

interface ComboMeal {
  id: string;
  name: string;
  bundle_price_cents: number;
  is_active: number;
  items: { menu_item_id: string; name: string; quantity: number; price_cents: number }[];
}

interface HappyHourRule {
  id: string;
  menu_item_id: string;
  menu_item_name: string;
  discount_percent: number;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: number;
}

interface MenuItemForm {
  name: string;
  category_id: string;
  price_cents: string;
  cost_cents: string;
  image_path: string;
  description: string;
  barcode: string;
}

interface CategoryForm {
  name: string;
  color: string;
  sort_order: string;
  image_path: string;
}

interface ComboForm {
  name: string;
  bundle_price_cents: string;
  items: { menu_item_id: string; quantity: string }[];
}

interface HappyHourForm {
  menu_item_id: string;
  discount_percent: string;
  day_of_week: string;
  start_time: string;
  end_time: string;
  is_active: boolean;
}

const emptyMenuItemForm: MenuItemForm = {
  name: "",
  category_id: "",
  price_cents: "",
  cost_cents: "",
  image_path: "",
  description: "",
  barcode: "",
};

const emptyCategoryForm: CategoryForm = {
  name: "",
  color: "#10b981",
  sort_order: "0",
  image_path: "",
};

const emptyComboForm: ComboForm = {
  name: "",
  bundle_price_cents: "",
  items: [],
};

const emptyHappyHourForm: HappyHourForm = {
  menu_item_id: "",
  discount_percent: "",
  day_of_week: "0",
  start_time: "10:00",
  end_time: "17:00",
  is_active: true,
};

const menuItemSchema = z.object({
  name: z.string().min(1, "الاسم مطلوب").max(100, "أقصى 100 حرف"),
  category_id: z.string().min(1, "التصنيف مطلوب"),
  price_cents: z.coerce.number().min(0, "يجب أن يكون 0 أو أكثر"),
  cost_cents: z.coerce.number().min(0, "يجب أن يكون 0 أو أكثر").optional().default(0),
  image_path: z.string().optional().default(""),
  description: z.string().optional().default(""),
  barcode: z.string().optional().default(""),
});

const categorySchema = z.object({
  name: z.string().min(1, "الاسم مطلوب").max(100, "أقصى 100 حرف"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "لون غير صالح"),
  sort_order: z.coerce.number().int().min(0, "يجب أن يكون 0 أو أكثر"),
  image_path: z.string().optional().default(""),
});

const comboFormSchema = z.object({
  name: z.string().min(1, "الاسم مطلوب").max(100, "أقصى 100 حرف"),
  bundle_price_cents: z.coerce.number().min(0, "يجب أن يكون 0 أو أكثر"),
  items: z
    .array(
      z.object({
        menu_item_id: z.string().min(1, "الصنف مطلوب"),
        quantity: z.coerce.number().int().min(1, "يجب أن يكون 1 على الأقل"),
      })
    )
    .min(1, "يجب إضافة صنف واحد على الأقل"),
});

const happyHourFormSchema = z.object({
  menu_item_id: z.string().min(1, "الصنف مطلوب"),
  discount_percent: z.coerce.number().int().min(0, "يجب أن يكون 0 أو أكثر").max(100, "أقصى 100%"),
  day_of_week: z.coerce.number().int().min(0).max(6),
  start_time: z.string().min(1, "وقت البداية مطلوب"),
  end_time: z.string().min(1, "وقت النهاية مطلوب"),
  is_active: z.boolean(),
});

const DAY_NAMES = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

type Tab = "items" | "categories" | "offers";
type OfferSubTab = "combos" | "happyhour";

function toCents(value: string): number {
  return Math.round(parseFloat(value || "0") * 100);
}

function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function calcMargin(price: number, cost: number): number {
  if (price <= 0) return 0;
  return Math.round(((price - cost) / price) * 100);
}

function marginBadge(margin: number) {
  if (margin > 30) return "bg-green-100 text-green-700";
  if (margin >= 10) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
}

export default function MenuPage() {
  const [tab, setTab] = useState<Tab>("items");
  const [offerSubTab, setOfferSubTab] = useState<OfferSubTab>("combos");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Items tab
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [showItemModal, setShowItemModal] = useState(false);
  const [editItemId, setEditItemId] = useState<string | null>(null);
  const [itemForm, setItemForm] = useState<MenuItemForm>(emptyMenuItemForm);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null);
  const [savingItem, setSavingItem] = useState(false);

  // Categories tab
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [editCategoryId, setEditCategoryId] = useState<string | null>(null);
  const [categoryForm, setCategoryForm] = useState<CategoryForm>(emptyCategoryForm);
  const [categoryErrors, setCategoryErrors] = useState<Record<string, string>>({});
  const [deleteCategoryId, setDeleteCategoryId] = useState<string | null>(null);
  const [categoryItemCounts, setCategoryItemCounts] = useState<Record<string, number>>({});
  const [savingCategory, setSavingCategory] = useState(false);

  // Combos tab
  const [combos, setCombos] = useState<ComboMeal[]>([]);
  const [showComboModal, setShowComboModal] = useState(false);
  const [editComboId, setEditComboId] = useState<string | null>(null);
  const [comboForm, setComboForm] = useState<ComboForm>(emptyComboForm);
  const [comboErrors, setComboErrors] = useState<Record<string, string>>({});
  const [savingCombo, setSavingCombo] = useState(false);

  // Happy Hour tab
  const [happyHourRules, setHappyHourRules] = useState<HappyHourRule[]>([]);
  const [showHappyHourModal, setShowHappyHourModal] = useState(false);
  const [editHappyHourId, setEditHappyHourId] = useState<string | null>(null);
  const [happyHourForm, setHappyHourForm] = useState<HappyHourForm>(emptyHappyHourForm);
  const [happyHourErrors, setHappyHourErrors] = useState<Record<string, string>>({});
  const [savingHappyHour, setSavingHappyHour] = useState(false);

  const filteredItems = menuItems.filter((item) => {
    const matchesSearch = item.name.includes(searchQuery);
    const matchesCategory = !filterCategory || item.category_id === filterCategory;
    return matchesSearch && matchesCategory;
  });

  const selectedCategoryName = (id: string) =>
    categories.find((c) => c.id === id)?.name ?? "---";

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const db = await getDb();
      const [cats, items] = await Promise.all([
        db
          .selectFrom("categories")
          .selectAll()
          .orderBy("sort_order", "asc")
          .execute(),
        db
          .selectFrom("menu_items")
          .selectAll()
          .orderBy("name", "asc")
          .execute(),
      ]);
      setCategories(cats);
      setMenuItems(items);

      const counts: Record<string, number> = {};
      for (const cat of cats) {
        const c = await db
          .selectFrom("menu_items")
          .select(db.fn.count<number>("id").as("count"))
          .where("category_id", "=", cat.id)
          .executeTakeFirst();
        counts[cat.id] = c?.count ?? 0;
      }
      setCategoryItemCounts(counts);

      const [comboRows, comboItemRows, happyRows] = await Promise.all([
        db.selectFrom("combo_meals").selectAll().orderBy("name", "asc").execute(),
        db
          .selectFrom("combo_items")
          .innerJoin("menu_items", "menu_items.id", "combo_items.menu_item_id")
          .select([
            "combo_items.combo_id",
            "combo_items.menu_item_id",
            "combo_items.quantity",
            "menu_items.name",
            "menu_items.price_cents",
          ])
          .execute(),
        db
          .selectFrom("happy_hour_rules")
          .innerJoin("menu_items", "menu_items.id", "happy_hour_rules.menu_item_id")
          .select([
            "happy_hour_rules.id",
            "happy_hour_rules.menu_item_id",
            "happy_hour_rules.discount_percent",
            "happy_hour_rules.day_of_week",
            "happy_hour_rules.start_time",
            "happy_hour_rules.end_time",
            "happy_hour_rules.is_active",
            "menu_items.name as menu_item_name",
          ])
          .orderBy("happy_hour_rules.day_of_week", "asc")
          .execute(),
      ]);

      const comboMap: Record<string, ComboMeal> = {};
      for (const c of comboRows) {
        comboMap[c.id] = { ...c, items: [] };
      }
      for (const ci of comboItemRows) {
        if (comboMap[ci.combo_id]) {
          comboMap[ci.combo_id].items.push({
            menu_item_id: ci.menu_item_id,
            name: ci.name,
            quantity: ci.quantity,
            price_cents: ci.price_cents,
          });
        }
      }
      setCombos(Object.values(comboMap));
      setHappyHourRules(happyRows);
    } catch (e) {
      setError("حدث خطأ في تحميل الصفحة: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ---- Menu Items ----
  const openAddItem = () => {
    setEditItemId(null);
    setItemForm(emptyMenuItemForm);
    setItemErrors({});
    setShowItemModal(true);
  };

  const openEditItem = (item: MenuItem) => {
    setEditItemId(item.id);
    setItemForm({
      name: item.name,
      category_id: item.category_id,
      price_cents: fromCents(item.price_cents),
      cost_cents: fromCents(item.cost_cents),
      image_path: item.image_path ?? "",
      description: item.description ?? "",
      barcode: item.barcode ?? "",
    });
    setItemErrors({});
    setShowItemModal(true);
  };

  const saveItem = async () => {
    const parsed = menuItemSchema.safeParse(itemForm);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as string;
        errs[field] = issue.message;
      }
      setItemErrors(errs);
      return;
    }
    setSavingItem(true);
    try {
      const db = await getDb();
      const data = {
        name: parsed.data.name,
        category_id: parsed.data.category_id,
        price_cents: toCents(itemForm.price_cents),
        cost_cents: toCents(itemForm.cost_cents),
        image_path: parsed.data.image_path || null,
        description: parsed.data.description || null,
        barcode: parsed.data.barcode || null,
      };
      if (editItemId) {
        await db
          .updateTable("menu_items")
          .set(data)
          .where("id", "=", editItemId)
          .execute();
      } else {
        await db
          .insertInto("menu_items")
          .values({ id: crypto.randomUUID(), ...data, is_active: 1, recipe_id: null, is_combo: 0 })
          .execute();
      }
      setShowItemModal(false);
      await fetchAll();
    } catch (err: any) {
      if (err?.message?.includes("UNIQUE")) {
        setItemErrors({ barcode: "الباركود موجود مسبقاً" });
      } else {
        setItemErrors({ _form: "حدث خطأ في الحفظ" });
      }
    } finally {
      setSavingItem(false);
    }
  };

  const confirmDeleteItem = async () => {
    if (!deleteItemId) return;
    try {
      const db = await getDb();
      await db
        .deleteFrom("menu_items")
        .where("id", "=", deleteItemId)
        .execute();
      setDeleteItemId(null);
      await fetchAll();
    } catch {
      setError("حدث خطأ في الحذف");
    }
  };

  const toggleItemStatus = async (item: MenuItem) => {
    try {
      const db = await getDb();
      await db
        .updateTable("menu_items")
        .set({ is_active: item.is_active ? 0 : 1 })
        .where("id", "=", item.id)
        .execute();
      await fetchAll();
    } catch {
      setError("حدث خطأ في تحديث الحالة");
    }
  };

  // ---- Categories ----
  const openAddCategory = () => {
    setEditCategoryId(null);
    setCategoryForm(emptyCategoryForm);
    setCategoryErrors({});
    setShowCategoryModal(true);
  };

  const openEditCategory = (cat: Category) => {
    setEditCategoryId(cat.id);
    setCategoryForm({
      name: cat.name,
      color: cat.color ?? "#10b981",
      sort_order: cat.sort_order.toString(),
      image_path: cat.image_path ?? "",
    });
    setCategoryErrors({});
    setShowCategoryModal(true);
  };

  const saveCategory = async () => {
    const parsed = categorySchema.safeParse(categoryForm);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as string;
        errs[field] = issue.message;
      }
      setCategoryErrors(errs);
      return;
    }
    setSavingCategory(true);
    try {
      const db = await getDb();
      const data = {
        name: parsed.data.name,
        color: parsed.data.color,
        sort_order: parseInt(categoryForm.sort_order, 10),
        image_path: parsed.data.image_path || null,
      };
      if (editCategoryId) {
        await db
          .updateTable("categories")
          .set(data)
          .where("id", "=", editCategoryId)
          .execute();
      } else {
        await db
          .insertInto("categories")
          .values({ id: crypto.randomUUID(), ...data, is_active: 1 })
          .execute();
      }
      setShowCategoryModal(false);
      await fetchAll();
    } catch {
      setCategoryErrors({ _form: "حدث خطأ في الحفظ" });
    } finally {
      setSavingCategory(false);
    }
  };

  const confirmDeleteCategory = async () => {
    if (!deleteCategoryId) return;
    try {
      const db = await getDb();
      await db
        .deleteFrom("categories")
        .where("id", "=", deleteCategoryId)
        .execute();
      setDeleteCategoryId(null);
      await fetchAll();
    } catch {
      setError("حدث خطأ في الحذف");
    }
  };

  // ---- Combos ----
  const openAddCombo = () => {
    setEditComboId(null);
    setComboForm(emptyComboForm);
    setComboErrors({});
    setShowComboModal(true);
  };

  const openEditCombo = (combo: ComboMeal) => {
    setEditComboId(combo.id);
    setComboForm({
      name: combo.name,
      bundle_price_cents: fromCents(combo.bundle_price_cents),
      items: combo.items.map((i) => ({
        menu_item_id: i.menu_item_id,
        quantity: i.quantity.toString(),
      })),
    });
    setComboErrors({});
    setShowComboModal(true);
  };

  const saveCombo = async () => {
    const parsed = comboFormSchema.safeParse(comboForm);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as string;
        errs[field] = issue.message;
      }
      setComboErrors(errs);
      return;
    }
    setSavingCombo(true);
    try {
      const db = await getDb();
      const comboId = editComboId || crypto.randomUUID();
      const bundleCents = toCents(comboForm.bundle_price_cents);

      if (editComboId) {
        await db
          .updateTable("combo_meals")
          .set({ name: parsed.data.name, bundle_price_cents: bundleCents })
          .where("id", "=", editComboId)
          .execute();
        await db
          .deleteFrom("combo_items")
          .where("combo_id", "=", editComboId)
          .execute();
      } else {
        await db
          .insertInto("combo_meals")
          .values({ id: comboId, name: parsed.data.name, bundle_price_cents: bundleCents, is_active: 1 })
          .execute();
      }

      for (const item of parsed.data.items) {
        await db
          .insertInto("combo_items")
          .values({
            id: crypto.randomUUID(),
            combo_id: comboId,
            menu_item_id: item.menu_item_id,
            quantity: item.quantity,
            sort_order: 0,
            is_free: 0,
          })
          .execute();
      }

      setShowComboModal(false);
      await fetchAll();
    } catch {
      setComboErrors({ _form: "حدث خطأ في الحفظ" });
    } finally {
      setSavingCombo(false);
    }
  };

  const toggleComboStatus = async (combo: ComboMeal) => {
    try {
      const db = await getDb();
      await db
        .updateTable("combo_meals")
        .set({ is_active: combo.is_active ? 0 : 1 })
        .where("id", "=", combo.id)
        .execute();
      await fetchAll();
    } catch {
      setError("حدث خطأ في تحديث الحالة");
    }
  };

  const addComboItemRow = () => {
    setComboForm((prev) => ({
      ...prev,
      items: [...prev.items, { menu_item_id: "", quantity: "1" }],
    }));
  };

  const updateComboItem = (index: number, field: "menu_item_id" | "quantity", value: string) => {
    setComboForm((prev) => {
      const items = [...prev.items];
      items[index] = { ...items[index], [field]: value };
      return { ...prev, items };
    });
  };

  const removeComboItem = (index: number) => {
    setComboForm((prev) => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index),
    }));
  };

  // ---- Happy Hour ----
  const openAddHappyHour = () => {
    setEditHappyHourId(null);
    setHappyHourForm(emptyHappyHourForm);
    setHappyHourErrors({});
    setShowHappyHourModal(true);
  };

  const openEditHappyHour = (rule: HappyHourRule) => {
    setEditHappyHourId(rule.id);
    setHappyHourForm({
      menu_item_id: rule.menu_item_id,
      discount_percent: rule.discount_percent.toString(),
      day_of_week: rule.day_of_week.toString(),
      start_time: rule.start_time,
      end_time: rule.end_time,
      is_active: !!rule.is_active,
    });
    setHappyHourErrors({});
    setShowHappyHourModal(true);
  };

  const saveHappyHour = async () => {
    const parsed = happyHourFormSchema.safeParse(happyHourForm);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as string;
        errs[field] = issue.message;
      }
      setHappyHourErrors(errs);
      return;
    }
    setSavingHappyHour(true);
    try {
      const db = await getDb();
      const data = {
        menu_item_id: parsed.data.menu_item_id,
        discount_percent: parseInt(happyHourForm.discount_percent, 10),
        day_of_week: parseInt(happyHourForm.day_of_week, 10),
        start_time: parsed.data.start_time,
        end_time: parsed.data.end_time,
        is_active: happyHourForm.is_active ? 1 : 0,
      };
      if (editHappyHourId) {
        await db
          .updateTable("happy_hour_rules")
          .set(data)
          .where("id", "=", editHappyHourId)
          .execute();
      } else {
        await db
          .insertInto("happy_hour_rules")
          .values({ id: crypto.randomUUID(), ...data })
          .execute();
      }
      setShowHappyHourModal(false);
      await fetchAll();
    } catch {
      setHappyHourErrors({ _form: "حدث خطأ في الحفظ" });
    } finally {
      setSavingHappyHour(false);
    }
  };

  const deleteHappyHour = async (id: string) => {
    try {
      const db = await getDb();
      await db
        .deleteFrom("happy_hour_rules")
        .where("id", "=", id)
        .execute();
      await fetchAll();
    } catch {
      setError("حدث خطأ في الحذف");
    }
  };

  const toggleHappyHourStatus = async (rule: HappyHourRule) => {
    try {
      const db = await getDb();
      await db
        .updateTable("happy_hour_rules")
        .set({ is_active: rule.is_active ? 0 : 1 })
        .where("id", "=", rule.id)
        .execute();
      await fetchAll();
    } catch {
      setError("حدث خطأ في تحديث الحالة");
    }
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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">إدارة القائمة</h1>
        {tab === "items" && (
          <button
            onClick={openAddItem}
            className="h-10 px-4 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors"
          >
            + إضافة صنف
          </button>
        )}
        {tab === "categories" && (
          <button
            onClick={openAddCategory}
            className="h-10 px-4 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors"
          >
            + إضافة تصنيف
          </button>
        )}
        {tab === "offers" && offerSubTab === "combos" && (
          <button
            onClick={openAddCombo}
            className="h-10 px-4 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors"
          >
            + إضافة وجبة مجمعة
          </button>
        )}
        {tab === "offers" && offerSubTab === "happyhour" && (
          <button
            onClick={openAddHappyHour}
            className="h-10 px-4 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors"
          >
            + إضافة قاعدة
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 pb-2">
        {(["items", "categories", "offers"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-t-lg font-arabic font-medium text-sm transition-colors ${
              tab === t
                ? "bg-emerald-600 text-white shadow-sm"
                : "text-slate-500 hover:text-emerald-600 hover:bg-white"
            }`}
          >
            {t === "items" ? "الأصناف" : t === "categories" ? "التصنيفات" : "العروض"}
          </button>
        ))}
      </div>

      {/* TAB: Items */}
      {tab === "items" && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ابحث عن صنف..."
              className="flex-1 h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
            />
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
            >
              <option value="">كل التصنيفات</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

          <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400 font-arabic">
                  <th className="text-right p-3 font-medium">الاسم</th>
                  <th className="text-right p-3 font-medium">التصنيف</th>
                  <th className="text-right p-3 font-medium">السعر</th>
                  <th className="text-right p-3 font-medium">التكلفة</th>
                  <th className="text-right p-3 font-medium">الهامش</th>
                  <th className="text-center p-3 font-medium">الحالة</th>
                  <th className="text-center p-3 font-medium">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const margin = calcMargin(item.price_cents, item.cost_cents);
                  return (
                    <tr key={item.id} className="border-b border-slate-200 hover:bg-white">
                      <td className="p-3 font-arabic text-slate-900">{item.name}</td>
                      <td className="p-3">
                        <span className="inline-block px-3 py-1 rounded-full text-xs font-arabic bg-emerald-50 text-emerald-700">
                          {selectedCategoryName(item.category_id)}
                        </span>
                      </td>
                      <td className="p-3 font-mono text-emerald-600 font-bold">
                        {fromCents(item.price_cents)}
                      </td>
                      <td className="p-3 font-mono text-slate-500">
                        {item.cost_cents > 0 ? fromCents(item.cost_cents) : "-"}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-mono font-bold ${marginBadge(margin)}`}
                        >
                          {margin}%
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <button
                          onClick={() => toggleItemStatus(item)}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                            item.is_active ? "bg-emerald-600" : "bg-slate-300"
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              item.is_active ? "translate-x-6" : "translate-x-1"
                            }`}
                          />
                        </button>
                      </td>
                      <td className="p-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => openEditItem(item)}
                            className="px-3 py-1 rounded-lg text-xs font-arabic text-emerald-600 hover:bg-emerald-50 transition-colors"
                          >
                            ✏️ تعديل
                          </button>
                          <button
                            onClick={() => setDeleteItemId(item.id)}
                            className="px-3 py-1 rounded-lg text-xs font-arabic text-red-500 hover:bg-red-50 transition-colors"
                          >
                            🗑️ حذف
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filteredItems.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-slate-500 font-arabic">
                      لا توجد أصناف
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB: Categories */}
      {tab === "categories" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {categories.map((cat) => (
              <div
                key={cat.id}
                className="bg-white rounded-2xl shadow-sm p-4 flex items-center gap-4"
              >
                <div
                  className="w-10 h-10 rounded-full flex-shrink-0"
                  style={{ backgroundColor: cat.color ?? "#10b981" }}
                />
                <div className="flex-1 min-w-0">
                  <p className="font-arabic font-bold text-slate-900 truncate">{cat.name}</p>
                  <p className="text-xs text-slate-500 font-arabic">
                    {categoryItemCounts[cat.id] ?? 0} صنف
                  </p>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => openEditCategory(cat)}
                    className="p-2 rounded-lg text-slate-500 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                    title="تعديل"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={() => {
                      if ((categoryItemCounts[cat.id] ?? 0) > 0) {
                        setError("لا يمكن حذف تصنيف يحتوي على أصناف");
                        return;
                      }
                      setDeleteCategoryId(cat.id);
                    }}
                    className="p-2 rounded-lg text-slate-500 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="حذف"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
            {categories.length === 0 && (
              <div className="col-span-full text-center text-slate-500 font-arabic py-8">
                لا توجد تصنيفات
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB: Offers */}
      {tab === "offers" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            {(["combos", "happyhour"] as OfferSubTab[]).map((st) => (
              <button
                key={st}
                onClick={() => setOfferSubTab(st)}
                className={`px-4 py-2 rounded-lg font-arabic font-medium text-sm transition-colors ${
                  offerSubTab === st
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-slate-500 hover:text-emerald-600 hover:bg-white"
                }`}
              >
                {st === "combos" ? "الوجبات المجمعة" : "ساعة السعادة"}
              </button>
            ))}
          </div>

          {offerSubTab === "combos" && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {combos.map((combo) => {
                const sumItems = combo.items.reduce(
                  (acc, i) => acc + i.price_cents * i.quantity,
                  0
                );
                const savings =
                  sumItems > 0
                    ? Math.round(((sumItems - combo.bundle_price_cents) / sumItems) * 100)
                    : 0;
                return (
                  <div
                    key={combo.id}
                    className="bg-white rounded-2xl shadow-sm p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="font-arabic font-bold text-slate-900">{combo.name}</h3>
                      <button
                        onClick={() => toggleComboStatus(combo)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          combo.is_active ? "bg-emerald-600" : "bg-slate-300"
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            combo.is_active ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-400 font-arabic">
                        السعر المجمع:{" "}
                        <span className="font-mono text-emerald-600 font-bold">
                          {fromCents(combo.bundle_price_cents)}
                        </span>
                      </span>
                      {savings > 0 && (
                        <span className="text-xs font-arabic text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                          وفر {savings}%
                        </span>
                      )}
                    </div>
                    <div className="space-y-1">
                      {combo.items.map((ci, idx) => (
                        <div
                          key={idx}
                          className="flex justify-between text-xs text-slate-400"
                        >
                          <span className="font-arabic">
                            {ci.name} × {ci.quantity}
                          </span>
                          <span className="font-mono">
                            {fromCents(ci.price_cents * ci.quantity)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => openEditCombo(combo)}
                      className="text-xs font-arabic text-emerald-600 hover:underline"
                    >
                      ✏️ تعديل
                    </button>
                  </div>
                );
              })}
              {combos.length === 0 && (
                <div className="col-span-full text-center text-slate-500 font-arabic py-8">
                  لا توجد وجبات مجمعة
                </div>
              )}
            </div>
          )}

          {offerSubTab === "happyhour" && (
            <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-400 font-arabic">
                    <th className="text-right p-3 font-medium">الصنف</th>
                    <th className="text-right p-3 font-medium">الخصم</th>
                    <th className="text-right p-3 font-medium">اليوم</th>
                    <th className="text-right p-3 font-medium">من</th>
                    <th className="text-right p-3 font-medium">إلى</th>
                    <th className="text-center p-3 font-medium">الحالة</th>
                    <th className="text-center p-3 font-medium">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {happyHourRules.map((rule) => (
                    <tr
                      key={rule.id}
                      className="border-b border-slate-200 hover:bg-white"
                    >
                      <td className="p-3 font-arabic text-slate-900">
                        {rule.menu_item_name}
                      </td>
                      <td className="p-3 font-mono text-amber-600 font-bold">
                        {rule.discount_percent}%
                      </td>
                      <td className="p-3 font-arabic text-slate-900">
                        {DAY_NAMES[rule.day_of_week] ?? rule.day_of_week}
                      </td>
                      <td className="p-3 font-mono text-slate-500">{rule.start_time}</td>
                      <td className="p-3 font-mono text-slate-500">{rule.end_time}</td>
                      <td className="p-3 text-center">
                        <button
                          onClick={() => toggleHappyHourStatus(rule)}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                            rule.is_active ? "bg-emerald-600" : "bg-slate-300"
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              rule.is_active ? "translate-x-6" : "translate-x-1"
                            }`}
                          />
                        </button>
                      </td>
                      <td className="p-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => openEditHappyHour(rule)}
                            className="px-3 py-1 rounded-lg text-xs font-arabic text-emerald-600 hover:bg-emerald-50 transition-colors"
                          >
                            ✏️ تعديل
                          </button>
                          <button
                            onClick={() => deleteHappyHour(rule.id)}
                            className="px-3 py-1 rounded-lg text-xs font-arabic text-red-500 hover:bg-red-50 transition-colors"
                          >
                            🗑️ حذف
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {happyHourRules.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-slate-500 font-arabic">
                        لا توجد قواعد ساعة سعيدة
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ---- MODALS ---- */}

      {/* Item Modal */}
      {showItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-slate-900">
              {editItemId ? "تعديل صنف" : "إضافة صنف"}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">الاسم *</label>
                <input
                  type="text"
                  value={itemForm.name}
                  onChange={(e) => setItemForm((p) => ({ ...p, name: e.target.value }))}
                  maxLength={100}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                />
                {itemErrors.name && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{itemErrors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">التصنيف *</label>
                <select
                  value={itemForm.category_id}
                  onChange={(e) => setItemForm((p) => ({ ...p, category_id: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                >
                  <option value="">اختر تصنيف</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
                {itemErrors.category_id && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{itemErrors.category_id}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-arabic text-slate-900 mb-1">السعر *</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemForm.price_cents}
                    onChange={(e) => setItemForm((p) => ({ ...p, price_cents: e.target.value }))}
                    className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                  />
                  {itemErrors.price_cents && (
                    <p className="text-xs text-red-500 mt-1 font-arabic">
                      {itemErrors.price_cents}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-arabic text-slate-900 mb-1">التكلفة</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemForm.cost_cents}
                    onChange={(e) => setItemForm((p) => ({ ...p, cost_cents: e.target.value }))}
                    className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                  />
                  {itemErrors.cost_cents && (
                    <p className="text-xs text-red-500 mt-1 font-arabic">
                      {itemErrors.cost_cents}
                    </p>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">
                  الباركود (اختياري)
                </label>
                <input
                  type="text"
                  value={itemForm.barcode}
                  onChange={(e) => setItemForm((p) => ({ ...p, barcode: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                />
                {itemErrors.barcode && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{itemErrors.barcode}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">
                  رابط الصورة (اختياري)
                </label>
                <input
                  type="text"
                  value={itemForm.image_path}
                  onChange={(e) => setItemForm((p) => ({ ...p, image_path: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 text-sm outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">الوصف</label>
                <textarea
                  value={itemForm.description}
                  onChange={(e) => setItemForm((p) => ({ ...p, description: e.target.value }))}
                  rows={3}
                  className="w-full px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500 resize-none"
                />
              </div>

              {itemErrors._form && (
                <p className="text-sm text-red-500 font-arabic">{itemErrors._form}</p>
              )}
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowItemModal(false)}
                className="h-10 px-6 rounded-xl bg-white text-slate-900 font-arabic text-sm hover:bg-slate-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={saveItem}
                disabled={savingItem}
                className="h-10 px-6 rounded-xl bg-emerald-600 text-white font-arabic text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                {savingItem ? "جاري الحفظ..." : "حفظ"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Item Confirmation */}
      {deleteItemId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-slate-900">تأكيد الحذف</h2>
            <p className="text-sm font-arabic text-slate-500">
              هل أنت متأكد من حذف هذا الصنف؟
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteItemId(null)}
                className="h-10 px-6 rounded-xl bg-white text-slate-900 font-arabic text-sm hover:bg-slate-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={confirmDeleteItem}
                className="h-10 px-6 rounded-xl bg-red-500 text-white font-arabic text-sm hover:bg-red-600 transition-colors"
              >
                حذف
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Category Modal */}
      {showCategoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-slate-900">
              {editCategoryId ? "تعديل تصنيف" : "إضافة تصنيف"}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">الاسم *</label>
                <input
                  type="text"
                  value={categoryForm.name}
                  onChange={(e) => setCategoryForm((p) => ({ ...p, name: e.target.value }))}
                  maxLength={100}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                />
                {categoryErrors.name && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{categoryErrors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">اللون</label>
                <div className="flex gap-3 items-center">
                  <input
                    type="color"
                    value={categoryForm.color}
                    onChange={(e) => setCategoryForm((p) => ({ ...p, color: e.target.value }))}
                    className="w-10 h-10 rounded-lg border border-slate-200 cursor-pointer"
                  />
                  <input
                    type="text"
                    value={categoryForm.color}
                    onChange={(e) => setCategoryForm((p) => ({ ...p, color: e.target.value }))}
                    placeholder="#10b981"
                    className="flex-1 h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                  />
                </div>
                {categoryErrors.color && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{categoryErrors.color}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">ترتيب الفرز</label>
                <input
                  type="number"
                  min="0"
                  value={categoryForm.sort_order}
                  onChange={(e) => setCategoryForm((p) => ({ ...p, sort_order: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                />
                {categoryErrors.sort_order && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">
                    {categoryErrors.sort_order}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">
                  رابط الصورة (اختياري)
                </label>
                <input
                  type="text"
                  value={categoryForm.image_path}
                  onChange={(e) => setCategoryForm((p) => ({ ...p, image_path: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 text-sm outline-none focus:border-emerald-500"
                />
              </div>

              {categoryErrors._form && (
                <p className="text-sm text-red-500 font-arabic">{categoryErrors._form}</p>
              )}
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowCategoryModal(false)}
                className="h-10 px-6 rounded-xl bg-white text-slate-900 font-arabic text-sm hover:bg-slate-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={saveCategory}
                disabled={savingCategory}
                className="h-10 px-6 rounded-xl bg-emerald-600 text-white font-arabic text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                {savingCategory ? "جاري الحفظ..." : "حفظ"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Category Confirmation */}
      {deleteCategoryId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-slate-900">تأكيد الحذف</h2>
            <p className="text-sm font-arabic text-slate-500">
              هل أنت متأكد من حذف هذا التصنيف؟
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteCategoryId(null)}
                className="h-10 px-6 rounded-xl bg-white text-slate-900 font-arabic text-sm hover:bg-slate-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={confirmDeleteCategory}
                className="h-10 px-6 rounded-xl bg-red-500 text-white font-arabic text-sm hover:bg-red-600 transition-colors"
              >
                حذف
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Combo Modal */}
      {showComboModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-slate-900">
              {editComboId ? "تعديل وجبة مجمعة" : "إضافة وجبة مجمعة"}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">الاسم *</label>
                <input
                  type="text"
                  value={comboForm.name}
                  onChange={(e) => setComboForm((p) => ({ ...p, name: e.target.value }))}
                  maxLength={100}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                />
                {comboErrors.name && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{comboErrors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">
                  السعر المجمع *
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={comboForm.bundle_price_cents}
                  onChange={(e) =>
                    setComboForm((p) => ({ ...p, bundle_price_cents: e.target.value }))
                  }
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                />
                {comboErrors.bundle_price_cents && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">
                    {comboErrors.bundle_price_cents}
                  </p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-arabic text-slate-900">الأصناف *</label>
                  <button
                    onClick={addComboItemRow}
                    className="text-xs font-arabic text-emerald-600 hover:underline"
                  >
                    + إضافة صنف
                  </button>
                </div>
                {comboErrors.items && (
                  <p className="text-xs text-red-500 mb-2 font-arabic">{comboErrors.items}</p>
                )}
                <div className="space-y-2">
                  {comboForm.items.map((item, idx) => (
                    <div key={idx} className="flex gap-2 items-start">
                      <select
                        value={item.menu_item_id}
                        onChange={(e) => updateComboItem(idx, "menu_item_id", e.target.value)}
                        className="flex-1 h-10 px-3 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                      >
                        <option value="">اختر صنف</option>
                        {menuItems.map((mi) => (
                          <option key={mi.id} value={mi.id}>
                            {mi.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={(e) => updateComboItem(idx, "quantity", e.target.value)}
                        className="w-20 h-10 px-3 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                      />
                      <button
                        onClick={() => removeComboItem(idx)}
                        className="h-10 px-2 text-slate-500 hover:text-red-500 transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {comboErrors._form && (
                <p className="text-sm text-red-500 font-arabic">{comboErrors._form}</p>
              )}
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowComboModal(false)}
                className="h-10 px-6 rounded-xl bg-white text-slate-900 font-arabic text-sm hover:bg-slate-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={saveCombo}
                disabled={savingCombo}
                className="h-10 px-6 rounded-xl bg-emerald-600 text-white font-arabic text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                {savingCombo ? "جاري الحفظ..." : "حفظ"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Happy Hour Modal */}
      {showHappyHourModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-slate-900">
              {editHappyHourId ? "تعديل قاعدة ساعة سعيدة" : "إضافة قاعدة ساعة سعيدة"}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">الصنف *</label>
                <select
                  value={happyHourForm.menu_item_id}
                  onChange={(e) => setHappyHourForm((p) => ({ ...p, menu_item_id: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                >
                  <option value="">اختر صنف</option>
                  {menuItems.map((mi) => (
                    <option key={mi.id} value={mi.id}>
                      {mi.name}
                    </option>
                  ))}
                </select>
                {happyHourErrors.menu_item_id && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">
                    {happyHourErrors.menu_item_id}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">
                  نسبة الخصم % *
                </label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={happyHourForm.discount_percent}
                  onChange={(e) =>
                    setHappyHourForm((p) => ({ ...p, discount_percent: e.target.value }))
                  }
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                />
                {happyHourErrors.discount_percent && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">
                    {happyHourErrors.discount_percent}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">اليوم *</label>
                <select
                  value={happyHourForm.day_of_week}
                  onChange={(e) =>
                    setHappyHourForm((p) => ({ ...p, day_of_week: e.target.value }))
                  }
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                >
                  {DAY_NAMES.map((name, idx) => (
                    <option key={idx} value={idx}>
                      {name}
                    </option>
                  ))}
                </select>
                {happyHourErrors.day_of_week && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">
                    {happyHourErrors.day_of_week}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-arabic text-slate-900 mb-1">
                    وقت البداية *
                  </label>
                  <input
                    type="time"
                    value={happyHourForm.start_time}
                    onChange={(e) =>
                      setHappyHourForm((p) => ({ ...p, start_time: e.target.value }))
                    }
                    className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                  />
                  {happyHourErrors.start_time && (
                    <p className="text-xs text-red-500 mt-1 font-arabic">
                      {happyHourErrors.start_time}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-arabic text-slate-900 mb-1">
                    وقت النهاية *
                  </label>
                  <input
                    type="time"
                    value={happyHourForm.end_time}
                    onChange={(e) =>
                      setHappyHourForm((p) => ({ ...p, end_time: e.target.value }))
                    }
                    className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                  />
                  {happyHourErrors.end_time && (
                    <p className="text-xs text-red-500 mt-1 font-arabic">
                      {happyHourErrors.end_time}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-arabic text-slate-900">نشط</label>
                <button
                  onClick={() =>
                    setHappyHourForm((p) => ({ ...p, is_active: !p.is_active }))
                  }
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    happyHourForm.is_active ? "bg-emerald-600" : "bg-slate-300"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      happyHourForm.is_active ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>

              {happyHourErrors._form && (
                <p className="text-sm text-red-500 font-arabic">{happyHourErrors._form}</p>
              )}
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowHappyHourModal(false)}
                className="h-10 px-6 rounded-xl bg-white text-slate-900 font-arabic text-sm hover:bg-slate-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={saveHappyHour}
                disabled={savingHappyHour}
                className="h-10 px-6 rounded-xl bg-emerald-600 text-white font-arabic text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                {savingHappyHour ? "جاري الحفظ..." : "حفظ"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
