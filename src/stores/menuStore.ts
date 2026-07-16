import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "./authStore";
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
      const token = useAuthStore.getState().token;
      const allCategories = await invoke<{ id: string; name: string; color: string | null; sort_order: number; is_active: number }[]>(
        "list_categories_v3", { sessionToken: token }
      );
      const categories: Category[] = allCategories
        .filter((c) => c.is_active === 1)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((c) => ({ id: c.id, name: c.name, color: c.color, sort_order: c.sort_order }));

      const allMenuItems = await invoke<{
        id: string; name: string; price_cents: number; category_id: string; image_path: string | null;
        is_combo: number; combo_original_price_cents: number | null; combo_description: string | null;
        barcode: string | null; is_active: number;
      }[]>("list_menu_items_v3", { sessionToken: token });

      const itemsWithCombo: MenuItem[] = [];
      for (const item of allMenuItems.filter((i) => i.is_active === 1)) {
        let combo_components: ComboComponent[] = [];
        if (item.is_combo) {
          // See ComboComponentRow's doc comment (repo.rs): this mirrors an
          // existing combo_items.combo_id/menu_items.id data-model mismatch,
          // not a fix -- it returns empty on a real install today, same as
          // the old Kysely-based query did.
          const rows = await invoke<{ menu_item_id: string; menu_item_name: string; quantity: number }[]>(
            "list_combo_components_v3", { sessionToken: token, menuItemId: item.id }
          );
          combo_components = rows.map((r) => ({ menuItemId: r.menu_item_id, name: r.menu_item_name, qty: r.quantity }));
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
