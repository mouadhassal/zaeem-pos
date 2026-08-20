import { useEffect, useState, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { getBusinessMode } from "../../lib/orderService";
import { useAuthStore } from "../../stores/authStore";
import { invalidateMenuItemPhotoCache } from "../../hooks/useMenuItemPhoto";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import { z } from "zod";
import { realErrorText } from "../../lib/errors";
import { IconPencil, IconTrash, IconX } from "@tabler/icons-react";
import Typeahead from "../../components/ui/Typeahead";

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
  /** 'simple' | 'prepared' | 'composite' -- derived server-side (see
   *  Repo::recompute_item_kind), never set directly by this UI. */
  item_kind: string;
}

/** Display copy for `item_kind`, read-only everywhere -- the only way this
 *  value changes is indirectly (linking/unlinking a recipe ingredient
 *  below, or becoming part of a combo), never a manual selector, so a
 *  badge is never "wrong" the way a stale dropdown could be. */
const ITEM_KIND_LABEL: Record<string, { label: string; hint: string; className: string }> = {
  simple: {
    label: "بسيط",
    hint: "صنف عادي بدون مكونات مرتبطة من المخزون",
    className: "bg-ink-100 text-ink-600",
  },
  prepared: {
    label: "محضّر",
    hint: "يحتوي على مكونات من المخزون تُخصم تلقائياً عند البيع",
    className: "bg-blue-100 text-blue-700",
  },
  composite: {
    label: "مجمّع",
    hint: "جزء من وجبة مجمّعة",
    className: "bg-purple-100 text-purple-700",
  },
};

function itemKindMeta(kind: string) {
  return ITEM_KIND_LABEL[kind] ?? ITEM_KIND_LABEL.simple;
}

interface ComboMeal {
  id: string;
  name: string;
  bundle_price_cents: number;
  items: { menu_item_id: string; name: string; quantity: number; price_cents: number }[];
}

/** Only the fields the recipe picker needs -- inventory/page.tsx's own
 *  `Ingredient` interface carries stock/cost fields this modal never uses. */
interface IngredientOption {
  id: string;
  name: string;
  unit: string;
}

/** Mirrors `RecipeIngredientRow` (repo.rs) -- `id` is the `recipes.id`
 *  (needed to delete/update this specific link, not the ingredient's own id). */
interface RecipeIngredient {
  id: string;
  ingredient_id: string;
  ingredient_name: string;
  unit: string;
  quantity_needed: number;
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
  description: "",
  barcode: "",
};

const emptyCategoryForm: CategoryForm = {
  name: "",
  color: "#667085",
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
  const token = useAuthStore((s) => s.token);
  const [tab, setTab] = useState<Tab>("items");
  const [offerSubTab, setOfferSubTab] = useState<OfferSubTab>("combos");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Combo meals ("وجبة مجمعة" -- bundle a burger+fries+drink) and happy
  // hour (time-windowed discounts) are food-service merchandising
  // concepts with no equivalent for a pharmacy/retail business -- unlike
  // has_tables/has_kitchen's other effects (Sidebar's KDS filter,
  // pos/page.tsx's table UI), this tab had no gate at all until now. Tied
  // to has_kitchen specifically since that's the flag this codebase
  // already uses to mean "is this a food-service business."
  const [hasKitchen, setHasKitchen] = useState(true);
  useEffect(() => {
    getBusinessMode().then((m) => {
      setHasKitchen(m.has_kitchen);
      // Owner could have been sitting on "offers" before flipping the
      // setting off in another tab/session -- bounce back to a tab that
      // still exists rather than leave the content area stuck rendering
      // a tab the bar no longer offers a button for.
      setTab((t) => (!m.has_kitchen && t === "offers" ? "items" : t));
    }).catch(() => {});
  }, []);

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
  const [deletingItem, setDeletingItem] = useState(false);
  const [savingItem, setSavingItem] = useState(false);
  const [itemPhoto, setItemPhoto] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Recipe (ingredients used) -- same "save the item first" gate as photo
  // upload above: a recipe row links to a real menu_item_id, so it can't
  // exist before the item does.
  const [allIngredients, setAllIngredients] = useState<IngredientOption[]>([]);
  const [recipeIngredients, setRecipeIngredients] = useState<RecipeIngredient[]>([]);
  const [recipeIngredientQuery, setRecipeIngredientQuery] = useState("");
  const [selectedIngredient, setSelectedIngredient] = useState<IngredientOption | null>(null);
  const [recipeQuantity, setRecipeQuantity] = useState("");
  const [savingRecipeRow, setSavingRecipeRow] = useState(false);
  const [removingRecipeRowId, setRemovingRecipeRowId] = useState<string | null>(null);
  const [recipeError, setRecipeError] = useState<string | null>(null);

  // Categories tab
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [editCategoryId, setEditCategoryId] = useState<string | null>(null);
  const [categoryForm, setCategoryForm] = useState<CategoryForm>(emptyCategoryForm);
  const [categoryErrors, setCategoryErrors] = useState<Record<string, string>>({});
  const [deleteCategoryId, setDeleteCategoryId] = useState<string | null>(null);
  const [deletingCategory, setDeletingCategory] = useState(false);
  const [categoryItemCounts, setCategoryItemCounts] = useState<Record<string, number>>({});
  const [categoryPhoto, setCategoryPhoto] = useState<string | null>(null);
  const [uploadingCategoryPhoto, setUploadingCategoryPhoto] = useState(false);
  const [categoryPhotoError, setCategoryPhotoError] = useState<string | null>(null);
  const [savingCategory, setSavingCategory] = useState(false);

  // Combos tab
  const [combos, setCombos] = useState<ComboMeal[]>([]);
  const [showComboModal, setShowComboModal] = useState(false);
  const [editComboId, setEditComboId] = useState<string | null>(null);
  const [comboForm, setComboForm] = useState<ComboForm>(emptyComboForm);
  const [comboErrors, setComboErrors] = useState<Record<string, string>>({});
  const [savingCombo, setSavingCombo] = useState(false);
  const [deleteComboId, setDeleteComboId] = useState<string | null>(null);
  const [deletingCombo, setDeletingCombo] = useState(false);

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
      const [cats, items] = await Promise.all([
        invoke<Category[]>("list_categories_v3", { sessionToken: token }),
        invoke<MenuItem[]>("list_menu_items_v3", { sessionToken: token }),
      ]);
      setCategories(cats);
      setMenuItems(items);

      const counts: Record<string, number> = {};
      for (const cat of cats) {
        counts[cat.id] = items.filter((i) => i.category_id === cat.id).length;
      }
      setCategoryItemCounts(counts);

      const [comboRows, comboItemRows, happyRows] = await Promise.all([
        invoke<{ id: string; name: string; bundle_price_cents: number }[]>("list_combo_meals_v3", { sessionToken: token }),
        invoke<{ combo_id: string; menu_item_id: string; menu_item_name: string; quantity: number; price_cents: number }[]>(
          "list_combo_meal_items_v3", { sessionToken: token }
        ),
        invoke<{ id: string; menu_item_id: string; menu_item_name: string; discount_percent: number; day_of_week: number; start_time: string; end_time: string; is_active: number }[]>(
          "list_happy_hour_rules_v3", { sessionToken: token }
        ),
      ]);

      const comboMap: Record<string, ComboMeal> = {};
      for (const c of comboRows) {
        comboMap[c.id] = { ...c, items: [] };
      }
      for (const ci of comboItemRows) {
        if (comboMap[ci.combo_id]) {
          comboMap[ci.combo_id].items.push({
            menu_item_id: ci.menu_item_id,
            name: ci.menu_item_name,
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
  const fetchAllIngredientsOnce = () => {
    invoke<IngredientOption[]>("list_ingredients_v3", { sessionToken: token })
      .then(setAllIngredients)
      .catch(() => setAllIngredients([]));
  };

  const fetchRecipeIngredients = (itemId: string) => {
    invoke<RecipeIngredient[]>("list_recipe_ingredients_v3", { sessionToken: token, menuItemId: itemId })
      .then(setRecipeIngredients)
      .catch(() => setRecipeIngredients([]));
  };

  const resetRecipeForm = () => {
    setRecipeIngredients([]);
    setRecipeIngredientQuery("");
    setSelectedIngredient(null);
    setRecipeQuantity("");
    setRecipeError(null);
  };

  const openAddItem = () => {
    setEditItemId(null);
    setItemForm(emptyMenuItemForm);
    setItemErrors({});
    setItemPhoto(null);
    setPhotoError(null);
    resetRecipeForm();
    fetchAllIngredientsOnce();
    setShowItemModal(true);
  };

  const openEditItem = (item: MenuItem) => {
    setEditItemId(item.id);
    setItemForm({
      name: item.name,
      category_id: item.category_id,
      price_cents: String(item.price_cents),
      cost_cents: String(item.cost_cents),
      description: item.description ?? "",
      barcode: item.barcode ?? "",
    });
    setItemErrors({});
    setPhotoError(null);
    // P0 fix (2026-07-18): `item.image_path` from list_menu_items_v3 is now
    // just a "HAS_PHOTO" marker, not a usable image -- the real photo is
    // fetched lazily, on demand, only when this modal actually opens (not
    // embedded in every list load; see get_menu_item_photo_v3's doc
    // comment for why).
    if (item.image_path === "HAS_PHOTO") {
      setItemPhoto(null);
      invoke<string | null>("get_menu_item_photo_v3", { sessionToken: token, itemId: item.id })
        .then(setItemPhoto)
        .catch(() => setItemPhoto(null));
    } else {
      setItemPhoto(null);
    }
    resetRecipeForm();
    fetchAllIngredientsOnce();
    fetchRecipeIngredients(item.id);
    setShowItemModal(true);
  };

  const addRecipeRow = async () => {
    if (!editItemId || !selectedIngredient) return;
    const qty = parseFloat(recipeQuantity);
    if (!qty || qty <= 0) {
      setRecipeError("الكمية يجب أن تكون أكبر من صفر");
      return;
    }
    setRecipeError(null);
    setSavingRecipeRow(true);
    try {
      await invoke("add_recipe_ingredient_v3", {
        sessionToken: token,
        menuItemId: editItemId,
        ingredientId: selectedIngredient.id,
        quantityNeeded: qty,
      });
      setSelectedIngredient(null);
      setRecipeIngredientQuery("");
      setRecipeQuantity("");
      fetchRecipeIngredients(editItemId);
    } catch (e) {
      setRecipeError(realErrorText(e));
    } finally {
      setSavingRecipeRow(false);
    }
  };

  const removeRecipeRow = async (recipeId: string) => {
    if (!editItemId) return;
    setRemovingRecipeRowId(recipeId);
    setRecipeError(null);
    try {
      await invoke("delete_recipe_ingredient_v3", { sessionToken: token, recipeId });
      fetchRecipeIngredients(editItemId);
    } catch (e) {
      setRecipeError(realErrorText(e));
    } finally {
      setRemovingRecipeRowId(null);
    }
  };

  const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

  const uploadItemPhoto = async (file: File) => {
    if (!editItemId) return; // an item must exist (be saved) before a photo can be attached to it
    setPhotoError(null);
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError("الصورة كبيرة جداً (الحد الأقصى 3 ميجابايت)");
      return;
    }
    setUploadingPhoto(true);
    try {
      const buf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      await invoke("upload_menu_item_photo_v3", { sessionToken: token, itemId: editItemId, photoBytes: bytes });
      invalidateMenuItemPhotoCache(editItemId);
      const [items, freshPhoto] = await Promise.all([
        invoke<MenuItem[]>("list_menu_items_v3", { sessionToken: token }),
        invoke<string | null>("get_menu_item_photo_v3", { sessionToken: token, itemId: editItemId }),
      ]);
      setMenuItems(items);
      setItemPhoto(freshPhoto);
    } catch {
      setPhotoError("فشل رفع الصورة -- تأكد أنها JPEG أو PNG أو WEBP");
    } finally {
      setUploadingPhoto(false);
    }
  };

  const removeItemPhoto = async () => {
    if (!editItemId) return;
    setUploadingPhoto(true);
    try {
      await invoke("delete_menu_item_photo_v3", { sessionToken: token, itemId: editItemId });
      invalidateMenuItemPhotoCache(editItemId);
      setItemPhoto(null);
      const items = await invoke<MenuItem[]>("list_menu_items_v3", { sessionToken: token });
      setMenuItems(items);
    } catch {
      setPhotoError("فشل حذف الصورة");
    } finally {
      setUploadingPhoto(false);
    }
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
      const args = {
        sessionToken: token,
        name: parsed.data.name,
        categoryId: parsed.data.category_id,
        priceCents: parseMoneyInput(itemForm.price_cents),
        costCents: parseMoneyInput(itemForm.cost_cents),
        description: parsed.data.description || null,
        barcode: parsed.data.barcode || null,
      };
      if (editItemId) {
        await invoke("update_menu_item_v3", { ...args, itemId: editItemId });
      } else {
        await invoke("create_menu_item_v3", args);
      }
      setShowItemModal(false);
      await fetchAll();
    } catch (err: any) {
      if (typeof err === "string" && err.includes("UNIQUE")) {
        setItemErrors({ barcode: "الباركود موجود مسبقاً" });
      } else {
        setItemErrors({ _form: `حدث خطأ في الحفظ: ${realErrorText(err)}` });
      }
    } finally {
      setSavingItem(false);
    }
  };

  const confirmDeleteItem = async () => {
    if (!deleteItemId || deletingItem) return;
    setDeletingItem(true);
    try {
      await invoke("delete_menu_item_v3", { sessionToken: token, itemId: deleteItemId });
      setDeleteItemId(null);
      await fetchAll();
    } catch (err) {
      setError(`حدث خطأ في الحذف: ${realErrorText(err)}`);
    } finally {
      setDeletingItem(false);
    }
  };

  const toggleItemStatus = async (item: MenuItem) => {
    try {
      await invoke("set_menu_item_active_v3", { sessionToken: token, itemId: item.id, isActive: !item.is_active });
      await fetchAll();
    } catch (err) {
      setError(`حدث خطأ في تحديث الحالة: ${realErrorText(err)}`);
    }
  };

  // ---- Categories ----
  const openAddCategory = () => {
    setEditCategoryId(null);
    setCategoryForm(emptyCategoryForm);
    setCategoryErrors({});
    setCategoryPhoto(null);
    setCategoryPhotoError(null);
    setShowCategoryModal(true);
  };

  const openEditCategory = (cat: Category) => {
    setEditCategoryId(cat.id);
    setCategoryForm({
      name: cat.name,
      color: cat.color ?? "#667085",
      sort_order: cat.sort_order.toString(),
      image_path: cat.image_path ?? "",
    });
    setCategoryErrors({});
    setCategoryPhotoError(null);
    // Same lazy-fetch pattern as menu items -- see get_menu_item_photo_v3's
    // doc comment for why the real photo isn't embedded in every list load.
    if (cat.image_path) {
      setCategoryPhoto(null);
      invoke<string | null>("get_category_photo_v3", { sessionToken: token, categoryId: cat.id })
        .then(setCategoryPhoto)
        .catch(() => setCategoryPhoto(null));
    } else {
      setCategoryPhoto(null);
    }
    setShowCategoryModal(true);
  };

  const uploadCategoryPhoto = async (file: File) => {
    if (!editCategoryId) return; // a category must exist (be saved) before a photo can be attached to it
    setCategoryPhotoError(null);
    if (file.size > MAX_PHOTO_BYTES) {
      setCategoryPhotoError("الصورة كبيرة جداً (الحد الأقصى 3 ميجابايت)");
      return;
    }
    setUploadingCategoryPhoto(true);
    try {
      const buf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      await invoke("upload_category_photo_v3", { sessionToken: token, categoryId: editCategoryId, photoBytes: bytes });
      const freshPhoto = await invoke<string | null>("get_category_photo_v3", { sessionToken: token, categoryId: editCategoryId });
      setCategoryPhoto(freshPhoto);
      await fetchAll();
    } catch {
      setCategoryPhotoError("فشل رفع الصورة -- تأكد أنها JPEG أو PNG أو WEBP");
    } finally {
      setUploadingCategoryPhoto(false);
    }
  };

  const removeCategoryPhoto = async () => {
    if (!editCategoryId) return;
    setUploadingCategoryPhoto(true);
    try {
      await invoke("delete_category_photo_v3", { sessionToken: token, categoryId: editCategoryId });
      setCategoryPhoto(null);
      await fetchAll();
    } catch {
      setCategoryPhotoError("فشل حذف الصورة");
    } finally {
      setUploadingCategoryPhoto(false);
    }
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
      const args = {
        sessionToken: token,
        name: parsed.data.name,
        color: parsed.data.color,
        sortOrder: parseInt(categoryForm.sort_order, 10),
        imagePath: parsed.data.image_path || null,
      };
      if (editCategoryId) {
        await invoke("update_category_v3", { ...args, categoryId: editCategoryId });
      } else {
        await invoke("create_category_v3", args);
      }
      setShowCategoryModal(false);
      await fetchAll();
    } catch (err) {
      setCategoryErrors({ _form: `حدث خطأ في الحفظ: ${realErrorText(err)}` });
    } finally {
      setSavingCategory(false);
    }
  };

  const confirmDeleteCategory = async () => {
    if (!deleteCategoryId || deletingCategory) return;
    setDeletingCategory(true);
    try {
      await invoke("delete_category_v3", { sessionToken: token, categoryId: deleteCategoryId });
      setDeleteCategoryId(null);
      await fetchAll();
    } catch (err) {
      setError(`حدث خطأ في الحذف: ${realErrorText(err)}`);
    } finally {
      setDeletingCategory(false);
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
      bundle_price_cents: String(combo.bundle_price_cents),
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
      const bundleCents = parseMoneyInput(comboForm.bundle_price_cents);
      const items: [string, number][] = parsed.data.items.map((i) => [i.menu_item_id, i.quantity]);

      if (editComboId) {
        await invoke("update_combo_meal_v3", { sessionToken: token, comboId: editComboId, name: parsed.data.name, bundlePriceCents: bundleCents, items });
      } else {
        await invoke("create_combo_meal_v3", { sessionToken: token, name: parsed.data.name, bundlePriceCents: bundleCents, items });
      }

      setShowComboModal(false);
      await fetchAll();
    } catch (err) {
      setComboErrors({ _form: `حدث خطأ في الحفظ: ${realErrorText(err)}` });
    } finally {
      setSavingCombo(false);
    }
  };

  const confirmDeleteCombo = async () => {
    if (!deleteComboId || deletingCombo) return;
    setDeletingCombo(true);
    try {
      await invoke("delete_combo_meal_v3", { sessionToken: token, comboId: deleteComboId });
      setDeleteComboId(null);
      await fetchAll();
    } catch (err) {
      setError(`حدث خطأ في الحذف: ${realErrorText(err)}`);
    } finally {
      setDeletingCombo(false);
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
      const args = {
        sessionToken: token,
        menuItemId: parsed.data.menu_item_id,
        discountPercent: parseInt(happyHourForm.discount_percent, 10),
        dayOfWeek: parseInt(happyHourForm.day_of_week, 10),
        startTime: parsed.data.start_time,
        endTime: parsed.data.end_time,
        isActive: happyHourForm.is_active,
      };
      if (editHappyHourId) {
        await invoke("update_happy_hour_rule_v3", { ...args, ruleId: editHappyHourId });
      } else {
        await invoke("create_happy_hour_rule_v3", args);
      }
      setShowHappyHourModal(false);
      await fetchAll();
    } catch (err) {
      setHappyHourErrors({ _form: `حدث خطأ في الحفظ: ${realErrorText(err)}` });
    } finally {
      setSavingHappyHour(false);
    }
  };

  const deleteHappyHour = async (id: string) => {
    try {
      await invoke("delete_happy_hour_rule_v3", { sessionToken: token, ruleId: id });
      await fetchAll();
    } catch (err) {
      setError(`حدث خطأ في الحذف: ${realErrorText(err)}`);
    }
  };

  const toggleHappyHourStatus = async (rule: HappyHourRule) => {
    try {
      await invoke("set_happy_hour_rule_active_v3", { sessionToken: token, ruleId: rule.id, isActive: !rule.is_active });
      await fetchAll();
    } catch (err) {
      setError(`حدث خطأ في تحديث الحالة: ${realErrorText(err)}`);
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
    <div className="p-6 space-y-6 overflow-y-auto h-full bg-canvas" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">{hasKitchen ? "إدارة القائمة" : "إدارة المنتجات"}</h1>
        {tab === "items" && (
          <button
            onClick={openAddItem}
            className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
          >
            + إضافة صنف
          </button>
        )}
        {tab === "categories" && (
          <button
            onClick={openAddCategory}
            className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
          >
            + إضافة تصنيف
          </button>
        )}
        {tab === "offers" && offerSubTab === "combos" && (
          <button
            onClick={openAddCombo}
            className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
          >
            + إضافة وجبة مجمعة
          </button>
        )}
        {tab === "offers" && offerSubTab === "happyhour" && (
          <button
            onClick={openAddHappyHour}
            className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
          >
            + إضافة قاعدة
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-ink-200 pb-2">
        {(["items", "categories", ...(hasKitchen ? (["offers"] as Tab[]) : [])] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-t-sm font-arabic font-medium text-sm transition-colors ${
              tab === t
                ? "bg-saffron-600 text-white"
                : "text-ink-500 hover:text-saffron-600 hover:bg-saffron-50"
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
              className="flex-1 h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
            />
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
            >
              <option value="">كل التصنيفات</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

          <div className="zc-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-alt border-b border-ink-200 text-ink-400 font-arabic">
                  <th className="text-right p-3 font-medium">الاسم</th>
                  <th className="text-right p-3 font-medium">النوع</th>
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
                    <tr key={item.id} className="border-b border-ink-200 hover:bg-saffron-50">
                      <td className="p-3 font-arabic text-ink-900">{item.name}</td>
                      <td className="p-3">
                        <span
                          title={itemKindMeta(item.item_kind).hint}
                          className={`inline-block px-2.5 py-1 rounded-full text-xs font-arabic ${itemKindMeta(item.item_kind).className}`}
                        >
                          {itemKindMeta(item.item_kind).label}
                        </span>
                      </td>
                      <td className="p-3">
                        <span className="inline-block px-3 py-1 rounded-full text-xs font-arabic bg-saffron-50 text-saffron-700">
                          {selectedCategoryName(item.category_id)}
                        </span>
                      </td>
                      <td className="p-3 font-mono text-saffron-600 font-bold">
                        {formatMoney(item.price_cents)}
                      </td>
                      <td className="p-3 font-mono text-ink-500">
                        {item.cost_cents > 0 ? formatMoney(item.cost_cents) : "-"}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-mono font-bold ${marginBadge(margin)}`}
                        >
                          {margin}%
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => toggleItemStatus(item)}
                            role="switch"
                            aria-checked={!!item.is_active}
                            dir="ltr"
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                              item.is_active ? "bg-saffron-600" : "bg-ink-300"
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                                item.is_active ? "translate-x-6" : "translate-x-1"
                              }`}
                            />
                          </button>
                          <span className={`text-xs font-arabic font-bold ${item.is_active ? "text-saffron-600" : "text-ink-400"}`}>
                            {item.is_active ? "مفعّل" : "متوقف"}
                          </span>
                        </div>
                      </td>
                      <td className="p-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => openEditItem(item)}
                            className="p-1.5 rounded-sm text-xs text-saffron-600 hover:bg-saffron-50 transition-colors"
                            title="تعديل"
                          >
                            <IconPencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setDeleteItemId(item.id)}
                            className="p-1.5 rounded-sm text-xs text-red-500 hover:bg-red-50 transition-colors"
                            title="حذف"
                          >
                            <IconTrash className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filteredItems.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-6 text-center text-ink-500 font-arabic">
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
                className="zc-card p-4 flex items-center gap-4"
              >
                <div
                  className="w-10 h-10 rounded-full flex-shrink-0"
                  style={{ backgroundColor: cat.color ?? "#667085" }}
                />
                <div className="flex-1 min-w-0">
                  <p className="font-arabic font-bold text-ink-900 truncate">{cat.name}</p>
                  <p className="text-xs text-ink-500 font-arabic">
                    {categoryItemCounts[cat.id] ?? 0} صنف
                  </p>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => openEditCategory(cat)}
                    className="p-2 rounded-sm text-ink-500 hover:text-saffron-600 hover:bg-saffron-50 transition-colors"
                    title="تعديل"
                  >
                    <IconPencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => {
                      if ((categoryItemCounts[cat.id] ?? 0) > 0) {
                        setError("لا يمكن حذف تصنيف يحتوي على أصناف");
                        return;
                      }
                      setDeleteCategoryId(cat.id);
                    }}
                    className="p-2 rounded-sm text-ink-500 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="حذف"
                  >
                    <IconTrash className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
            {categories.length === 0 && (
              <div className="col-span-full text-center text-ink-500 font-arabic py-8">
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
                className={`px-4 py-2 rounded-sm font-arabic font-medium text-sm transition-colors ${
                  offerSubTab === st
                    ? "bg-saffron-600 text-white"
                    : "text-ink-500 hover:text-saffron-600 hover:bg-saffron-50"
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
                    className="zc-card p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="font-arabic font-bold text-ink-900">{combo.name}</h3>
                      <div className="flex gap-2">
                        <button
                          onClick={() => openEditCombo(combo)}
                          className="px-3 py-1.5 rounded-sm bg-blue-100 text-blue-700 text-xs font-bold hover:bg-blue-200 transition-colors"
                        >
                          تعديل
                        </button>
                        <button
                          onClick={() => setDeleteComboId(combo.id)}
                          className="px-3 py-1.5 rounded-sm bg-red-100 text-red-700 text-xs font-bold hover:bg-red-200 transition-colors"
                        >
                          حذف
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-ink-400 font-arabic">
                        السعر المجمع:{" "}
                        <span className="font-mono text-saffron-600 font-bold">
                          {formatMoney(combo.bundle_price_cents)}
                        </span>
                      </span>
                      {savings > 0 && (
                        <span className="text-xs font-arabic text-saffron-600 bg-saffron-50 px-2 py-0.5 rounded-full">
                          وفر {savings}%
                        </span>
                      )}
                    </div>
                    <div className="space-y-1">
                      {combo.items.map((ci, idx) => (
                        <div
                          key={idx}
                          className="flex justify-between text-xs text-ink-400"
                        >
                          <span className="font-arabic">
                            {ci.name} × {ci.quantity}
                          </span>
                          <span className="font-mono">
                            {formatMoney(ci.price_cents * ci.quantity)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {combos.length === 0 && (
                <div className="col-span-full text-center text-ink-500 font-arabic py-8">
                  لا توجد وجبات مجمعة
                </div>
              )}
            </div>
          )}

          {offerSubTab === "happyhour" && (
            <div className="zc-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-alt border-b border-ink-200 text-ink-400 font-arabic">
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
                      className="border-b border-ink-200 hover:bg-saffron-50"
                    >
                      <td className="p-3 font-arabic text-ink-900">
                        {rule.menu_item_name}
                      </td>
                      <td className="p-3 font-mono text-amber-600 font-bold">
                        {rule.discount_percent}%
                      </td>
                      <td className="p-3 font-arabic text-ink-900">
                        {DAY_NAMES[rule.day_of_week] ?? rule.day_of_week}
                      </td>
                      <td className="p-3 font-mono text-ink-500">{rule.start_time}</td>
                      <td className="p-3 font-mono text-ink-500">{rule.end_time}</td>
                      <td className="p-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => toggleHappyHourStatus(rule)}
                            role="switch"
                            aria-checked={!!rule.is_active}
                            dir="ltr"
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                              rule.is_active ? "bg-saffron-600" : "bg-ink-300"
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                                rule.is_active ? "translate-x-6" : "translate-x-1"
                              }`}
                            />
                          </button>
                          <span className={`text-xs font-arabic font-bold ${rule.is_active ? "text-saffron-600" : "text-ink-400"}`}>
                            {rule.is_active ? "مفعّل" : "متوقف"}
                          </span>
                        </div>
                      </td>
                      <td className="p-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => openEditHappyHour(rule)}
                            className="p-1.5 rounded-sm text-xs text-saffron-600 hover:bg-saffron-50 transition-colors"
                            title="تعديل"
                          >
                            <IconPencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => deleteHappyHour(rule.id)}
                            className="p-1.5 rounded-sm text-xs text-red-500 hover:bg-red-50 transition-colors"
                            title="حذف"
                          >
                            <IconTrash className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {happyHourRules.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-ink-500 font-arabic">
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
            <h2 className="text-lg font-bold font-arabic text-ink-900">
              {editItemId ? "تعديل صنف" : "إضافة صنف"}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">الاسم *</label>
                <input
                  type="text"
                  value={itemForm.name}
                  onChange={(e) => setItemForm((p) => ({ ...p, name: e.target.value }))}
                  maxLength={100}
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
                />
                {itemErrors.name && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{itemErrors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">التصنيف *</label>
                <select
                  value={itemForm.category_id}
                  onChange={(e) => setItemForm((p) => ({ ...p, category_id: e.target.value }))}
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
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
                  <label className="block text-sm font-arabic text-ink-900 mb-1">السعر *</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemForm.price_cents}
                    onChange={(e) => setItemForm((p) => ({ ...p, price_cents: e.target.value }))}
                    className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                  />
                  {itemErrors.price_cents && (
                    <p className="text-xs text-red-500 mt-1 font-arabic">
                      {itemErrors.price_cents}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">التكلفة</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemForm.cost_cents}
                    onChange={(e) => setItemForm((p) => ({ ...p, cost_cents: e.target.value }))}
                    className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                  />
                  {itemErrors.cost_cents && (
                    <p className="text-xs text-red-500 mt-1 font-arabic">
                      {itemErrors.cost_cents}
                    </p>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">
                  الباركود (اختياري)
                </label>
                <input
                  type="text"
                  value={itemForm.barcode}
                  onChange={(e) => setItemForm((p) => ({ ...p, barcode: e.target.value }))}
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                />
                {itemErrors.barcode && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{itemErrors.barcode}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">
                  صورة الصنف (اختياري)
                </label>
                {editItemId ? (
                  <div className="flex items-center gap-3">
                    <div className="w-[62px] h-[62px] shrink-0 rounded-md overflow-hidden border border-ink-200 bg-ink-100 flex items-center justify-center">
                      {itemPhoto ? (
                        <img src={itemPhoto} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[10px] text-ink-400 font-arabic text-center px-1">
                          بدون صورة
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="h-9 px-4 rounded-sm bg-saffron-600 text-white text-xs font-arabic flex items-center justify-center cursor-pointer hover:bg-saffron-700 transition-colors">
                        {uploadingPhoto ? "جاري الرفع..." : itemPhoto ? "تغيير الصورة" : "رفع صورة"}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          className="hidden"
                          disabled={uploadingPhoto}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void uploadItemPhoto(file);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      {itemPhoto && (
                        <button
                          type="button"
                          onClick={removeItemPhoto}
                          disabled={uploadingPhoto}
                          className="h-9 px-4 rounded-sm bg-white text-ink-700 border border-ink-200 text-xs font-arabic hover:bg-ink-50 transition-colors disabled:opacity-50"
                        >
                          إزالة الصورة
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-ink-400 font-arabic">
                    احفظ الصنف أولاً، بعدها تقدر ترفع صورة له
                  </p>
                )}
                {photoError && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{photoError}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">الوصف</label>
                <textarea
                  value={itemForm.description}
                  onChange={(e) => setItemForm((p) => ({ ...p, description: e.target.value }))}
                  rows={3}
                  className="w-full px-4 py-2 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600 resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">
                  المكونات المستهلكة (اختياري)
                </label>
                {editItemId ? (
                  <div className="space-y-2">
                    {(() => {
                      // Live-derived, not read from `item.item_kind` (which
                      // would only refresh after a full fetchAll) -- mirrors
                      // Repo::recompute_item_kind's own priority exactly:
                      // composite (from is_combo, unreachable from this
                      // modal -- combos are a separate entity, managed in
                      // the Offers tab) still wins, otherwise it's
                      // 'prepared' the instant a row is added and reverts
                      // to 'simple' the instant the last one is removed.
                      const baseItem = menuItems.find((m) => m.id === editItemId);
                      const liveKind =
                        baseItem?.item_kind === "composite"
                          ? "composite"
                          : recipeIngredients.length > 0
                          ? "prepared"
                          : "simple";
                      const meta = itemKindMeta(liveKind);
                      return (
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-arabic ${meta.className}`}>
                            {meta.label}
                          </span>
                          <span className="text-[11px] text-ink-400 font-arabic">{meta.hint}</span>
                        </div>
                      );
                    })()}
                    {recipeIngredients.length > 0 && (
                      <ul className="space-y-1.5">
                        {recipeIngredients.map((r) => (
                          <li
                            key={r.id}
                            className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-sm bg-ink-50 border border-ink-200"
                          >
                            <span className="text-sm font-arabic text-ink-900">
                              {r.ingredient_name}
                              <span className="text-ink-400 font-mono text-xs mx-1.5" dir="ltr">
                                {r.quantity_needed} {r.unit}
                              </span>
                            </span>
                            <button
                              type="button"
                              onClick={() => removeRecipeRow(r.id)}
                              disabled={removingRecipeRowId === r.id}
                              className="text-red-500 hover:text-red-600 disabled:opacity-50"
                              aria-label="إزالة المكوّن"
                            >
                              <IconX size={16} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="flex gap-2 items-start">
                      <div className="flex-1">
                        <Typeahead
                          value={selectedIngredient ? selectedIngredient.name : recipeIngredientQuery}
                          onChange={(v) => {
                            setRecipeIngredientQuery(v);
                            setSelectedIngredient(null);
                          }}
                          items={allIngredients.filter(
                            (ing) => !recipeIngredients.some((r) => r.ingredient_id === ing.id)
                          )}
                          filterItem={(item, q) => item.name.includes(q)}
                          getKey={(item) => item.id}
                          onSelect={(item) => {
                            setSelectedIngredient(item);
                            setRecipeIngredientQuery(item.name);
                          }}
                          renderItem={(item) => (
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-ink-900">{item.name}</span>
                              <span className="text-ink-400 text-xs">{item.unit}</span>
                            </div>
                          )}
                          placeholder="ابحث عن مكوّن..."
                          emptyMessage="لا توجد مكوّنات مطابقة"
                        />
                      </div>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={recipeQuantity}
                        onChange={(e) => setRecipeQuantity(e.target.value)}
                        placeholder="الكمية"
                        className="w-24 h-10 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                      />
                      <button
                        type="button"
                        onClick={addRecipeRow}
                        disabled={!selectedIngredient || savingRecipeRow}
                        className="h-10 px-4 rounded-sm bg-ink-100 text-ink-900 text-sm font-arabic hover:bg-ink-200 transition-colors disabled:opacity-50 shrink-0"
                      >
                        {savingRecipeRow ? "..." : "إضافة"}
                      </button>
                    </div>
                    {recipeError && <p className="text-xs text-red-500 font-arabic">{recipeError}</p>}
                    <p className="text-[11px] text-ink-400 font-arabic">
                      كل مكوّن مرتبط ينقص تلقائياً من المخزون عند بيع الصنف.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-ink-400 font-arabic">
                    احفظ الصنف أولاً، بعدها تقدر تربطه بمكوّنات من المخزون
                  </p>
                )}
              </div>

              {itemErrors._form && (
                <p className="text-sm text-red-500 font-arabic">{itemErrors._form}</p>
              )}
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowItemModal(false)}
                className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={saveItem}
                disabled={savingItem}
                className="h-10 px-6 rounded-sm bg-saffron-600 text-white font-arabic text-sm hover:bg-saffron-700 transition-colors disabled:opacity-50"
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
            <h2 className="text-lg font-bold font-arabic text-ink-900">تأكيد الحذف</h2>
            <p className="text-sm font-arabic text-ink-500">
              هل أنت متأكد من حذف هذا الصنف؟
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteItemId(null)}
                className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={confirmDeleteItem}
                disabled={deletingItem}
                className="h-10 px-6 rounded-sm bg-red-500 text-white font-arabic text-sm hover:bg-red-600 transition-colors disabled:opacity-40"
              >
                {deletingItem ? "جاري..." : "حذف"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Combo Confirmation */}
      {deleteComboId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">تأكيد الحذف</h2>
            <p className="text-sm font-arabic text-ink-500">
              هل أنت متأكد من حذف هذه الوجبة المجمعة؟
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteComboId(null)}
                className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={confirmDeleteCombo}
                disabled={deletingCombo}
                className="h-10 px-6 rounded-sm bg-red-500 text-white font-arabic text-sm hover:bg-red-600 transition-colors disabled:opacity-40"
              >
                {deletingCombo ? "جاري..." : "حذف"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Category Modal */}
      {showCategoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">
              {editCategoryId ? "تعديل تصنيف" : "إضافة تصنيف"}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">الاسم *</label>
                <input
                  type="text"
                  value={categoryForm.name}
                  onChange={(e) => setCategoryForm((p) => ({ ...p, name: e.target.value }))}
                  maxLength={100}
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
                />
                {categoryErrors.name && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{categoryErrors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">اللون</label>
                <div className="flex gap-3 items-center">
                  <input
                    type="color"
                    value={categoryForm.color}
                    onChange={(e) => setCategoryForm((p) => ({ ...p, color: e.target.value }))}
                    className="w-10 h-10 rounded-sm border border-ink-200 cursor-pointer"
                  />
                  <input
                    type="text"
                    value={categoryForm.color}
                    onChange={(e) => setCategoryForm((p) => ({ ...p, color: e.target.value }))}
                    placeholder="#667085"
                    className="flex-1 h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                  />
                </div>
                {categoryErrors.color && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{categoryErrors.color}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">ترتيب الفرز</label>
                <input
                  type="number"
                  min="0"
                  value={categoryForm.sort_order}
                  onChange={(e) => setCategoryForm((p) => ({ ...p, sort_order: e.target.value }))}
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                />
                {categoryErrors.sort_order && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">
                    {categoryErrors.sort_order}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">
                  صورة التصنيف (اختياري)
                </label>
                {editCategoryId ? (
                  <div className="flex items-center gap-3">
                    <div className="w-[62px] h-[62px] shrink-0 rounded-md overflow-hidden border border-ink-200 bg-ink-100 flex items-center justify-center">
                      {categoryPhoto ? (
                        <img src={categoryPhoto} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[10px] text-ink-400 font-arabic text-center px-1">
                          بدون صورة
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="h-9 px-4 rounded-sm bg-saffron-600 text-white text-xs font-arabic flex items-center justify-center cursor-pointer hover:bg-saffron-700 transition-colors">
                        {uploadingCategoryPhoto ? "جاري الرفع..." : categoryPhoto ? "تغيير الصورة" : "رفع صورة"}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          className="hidden"
                          disabled={uploadingCategoryPhoto}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void uploadCategoryPhoto(file);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      {categoryPhoto && (
                        <button
                          type="button"
                          onClick={removeCategoryPhoto}
                          disabled={uploadingCategoryPhoto}
                          className="h-9 px-4 rounded-sm bg-white text-ink-700 border border-ink-200 text-xs font-arabic hover:bg-ink-50 transition-colors disabled:opacity-50"
                        >
                          إزالة الصورة
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-ink-400 font-arabic">
                    احفظ التصنيف أولاً، بعدها تقدر ترفع صورة له
                  </p>
                )}
                {categoryPhotoError && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{categoryPhotoError}</p>
                )}
              </div>

              {categoryErrors._form && (
                <p className="text-sm text-red-500 font-arabic">{categoryErrors._form}</p>
              )}
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowCategoryModal(false)}
                className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={saveCategory}
                disabled={savingCategory}
                className="h-10 px-6 rounded-sm bg-saffron-600 text-white font-arabic text-sm hover:bg-saffron-700 transition-colors disabled:opacity-50"
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
            <h2 className="text-lg font-bold font-arabic text-ink-900">تأكيد الحذف</h2>
            <p className="text-sm font-arabic text-ink-500">
              هل أنت متأكد من حذف هذا التصنيف؟
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteCategoryId(null)}
                className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={confirmDeleteCategory}
                disabled={deletingCategory}
                className="h-10 px-6 rounded-sm bg-red-500 text-white font-arabic text-sm hover:bg-red-600 transition-colors disabled:opacity-40"
              >
                {deletingCategory ? "جاري..." : "حذف"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Combo Modal */}
      {showComboModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">
              {editComboId ? "تعديل وجبة مجمعة" : "إضافة وجبة مجمعة"}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">الاسم *</label>
                <input
                  type="text"
                  value={comboForm.name}
                  onChange={(e) => setComboForm((p) => ({ ...p, name: e.target.value }))}
                  maxLength={100}
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
                />
                {comboErrors.name && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{comboErrors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">
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
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                />
                {comboErrors.bundle_price_cents && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">
                    {comboErrors.bundle_price_cents}
                  </p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-arabic text-ink-900">الأصناف *</label>
                  <button
                    onClick={addComboItemRow}
                    className="text-xs font-arabic text-saffron-600 hover:underline"
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
                        className="flex-1 h-10 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
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
                        className="w-20 h-10 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                      />
                      <button
                        onClick={() => removeComboItem(idx)}
                        className="h-10 px-2 text-ink-500 hover:text-red-500 transition-colors"
                      >
                        <IconX className="w-4 h-4" />
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
                className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={saveCombo}
                disabled={savingCombo}
                className="h-10 px-6 rounded-sm bg-saffron-600 text-white font-arabic text-sm hover:bg-saffron-700 transition-colors disabled:opacity-50"
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
            <h2 className="text-lg font-bold font-arabic text-ink-900">
              {editHappyHourId ? "تعديل قاعدة ساعة سعيدة" : "إضافة قاعدة ساعة سعيدة"}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">الصنف *</label>
                <select
                  value={happyHourForm.menu_item_id}
                  onChange={(e) => setHappyHourForm((p) => ({ ...p, menu_item_id: e.target.value }))}
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
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
                <label className="block text-sm font-arabic text-ink-900 mb-1">
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
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                />
                {happyHourErrors.discount_percent && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">
                    {happyHourErrors.discount_percent}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">اليوم *</label>
                <select
                  value={happyHourForm.day_of_week}
                  onChange={(e) =>
                    setHappyHourForm((p) => ({ ...p, day_of_week: e.target.value }))
                  }
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
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
                  <label className="block text-sm font-arabic text-ink-900 mb-1">
                    وقت البداية *
                  </label>
                  <input
                    type="time"
                    value={happyHourForm.start_time}
                    onChange={(e) =>
                      setHappyHourForm((p) => ({ ...p, start_time: e.target.value }))
                    }
                    className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                  />
                  {happyHourErrors.start_time && (
                    <p className="text-xs text-red-500 mt-1 font-arabic">
                      {happyHourErrors.start_time}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">
                    وقت النهاية *
                  </label>
                  <input
                    type="time"
                    value={happyHourForm.end_time}
                    onChange={(e) =>
                      setHappyHourForm((p) => ({ ...p, end_time: e.target.value }))
                    }
                    className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                  />
                  {happyHourErrors.end_time && (
                    <p className="text-xs text-red-500 mt-1 font-arabic">
                      {happyHourErrors.end_time}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-arabic text-ink-900">نشط</label>
                <button
                  onClick={() =>
                    setHappyHourForm((p) => ({ ...p, is_active: !p.is_active }))
                  }
                  role="switch"
                  aria-checked={happyHourForm.is_active}
                  dir="ltr"
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    happyHourForm.is_active ? "bg-saffron-600" : "bg-ink-300"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      happyHourForm.is_active ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
                <span className={`text-xs font-arabic font-bold ${happyHourForm.is_active ? "text-saffron-600" : "text-ink-400"}`}>
                  {happyHourForm.is_active ? "مفعّل" : "متوقف"}
                </span>
              </div>

              {happyHourErrors._form && (
                <p className="text-sm text-red-500 font-arabic">{happyHourErrors._form}</p>
              )}
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowHappyHourModal(false)}
                className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={saveHappyHour}
                disabled={savingHappyHour}
                className="h-10 px-6 rounded-sm bg-saffron-600 text-white font-arabic text-sm hover:bg-saffron-700 transition-colors disabled:opacity-50"
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
