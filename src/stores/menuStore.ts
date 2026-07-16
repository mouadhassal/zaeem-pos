import { create } from "zustand";
import { getDb } from "../db";
import { logger } from "../lib/logger";

interface Category {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
}

export interface ComboComponent {
  menuItemId: string;
  name: string;
  qty: number;
  isFree: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  price_cents: number;
  category_id: string;
  image_path: string | null;
  is_combo: boolean;
  combo_original_price_cents: number | null;
  combo_description: string | null;
  combo_components: ComboComponent[];
  barcode: string | null;
}

interface MenuState {
  categories: Category[];
  menuItems: MenuItem[];
  selectedCategoryId: string | null;
  searchQuery: string;
  loading: boolean;
  fetchMenu: () => Promise<void>;
  setSelectedCategory: (id: string | null) => void;
  setSearchQuery: (q: string) => void;
}

export const useMenuStore = create<MenuState>((set) => ({
  categories: [],
  menuItems: [],
  selectedCategoryId: null,
  searchQuery: "",
  loading: false,

  fetchMenu: async () => {
    set({ loading: true });
    try {
      const db = await getDb();
      const categories = await db
        .selectFrom("categories")
        .select(["id", "name", "color", "sort_order"])
        .where("is_active", "=", 1)
        .orderBy("sort_order")
        .execute();

      const menuItems = await db
        .selectFrom("menu_items")
        .selectAll()
        .where("is_active", "=", 1)
        .execute();

      const itemsWithCombo: MenuItem[] = [];
      for (const item of menuItems) {
        let combo_components: ComboComponent[] = [];
        if (item.is_combo) {
          const rows = await db
            .selectFrom("combo_items")
            .innerJoin("menu_items", "menu_items.id", "combo_items.menu_item_id")
            .select(["combo_items.menu_item_id", "menu_items.name", "combo_items.quantity", "combo_items.is_free"])
            .where("combo_items.combo_id", "=", item.id)
            .orderBy("combo_items.sort_order")
            .execute();
          combo_components = rows.map((r: any) => ({
            menuItemId: r.menu_item_id,
            name: r.name,
            qty: r.qty,
            isFree: r.is_free === 1,
          }));
        }
        itemsWithCombo.push({
          id: item.id,
          name: item.name,
          price_cents: item.price_cents,
          category_id: item.category_id,
          image_path: item.image_path,
          is_combo: item.is_combo === 1,
          combo_original_price_cents: item.combo_original_price_cents,
          combo_description: item.combo_description,
          combo_components,
          barcode: item.barcode,
        });
      }

      set({ categories, menuItems: itemsWithCombo, loading: false });
    } catch (err) {
      logger.error("Failed to fetch menu", { error: String(err) });
      set({ loading: false });
    }
  },

  setSelectedCategory: (id) => set({ selectedCategoryId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
}));

export function useFilteredMenuItems() {
  const items = useMenuStore((s) => s.menuItems);
  const catId = useMenuStore((s) => s.selectedCategoryId);
  const query = useMenuStore((s) => s.searchQuery);

  return items.filter((item) => {
    if (catId && item.category_id !== catId) return false;
    if (query && !item.name.includes(query)) return false;
    return true;
  });
}
