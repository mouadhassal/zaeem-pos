import { create } from "zustand";
import { invoke } from "../lib/invoke";
import { useAuthStore } from "./authStore";
import { logger } from "../lib/logger";
import { useComboStore } from "./comboStore";
import { useHappyHourStore, getActiveHappyHourDiscount } from "./happyHourStore";

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
  /** >0 when a happy-hour rule for this item is active right now (see happyHourStore.getActiveHappyHourDiscount). */
  happyHourDiscountPercent: number;
  /** price_cents with the active happy-hour discount already applied -- this, not price_cents, is what the cashier should charge/see right now. */
  effectivePriceCents: number;
}

interface MenuState {
  categories: Category[];
  menuItems: MenuItem[];
  selectedCategoryId: string | null;
  searchQuery: string;
  loading: boolean;
  error: string | null;
  fetchMenu: () => Promise<void>;
  setSelectedCategory: (id: string | null) => void;
  setSearchQuery: (q: string) => void;
}

export const useMenuStore = create<MenuState>((set) => ({
  categories: [],
  menuItems: [],
  selectedCategoryId: null,
  searchQuery: "",
  // Starts true, not false: fetchMenu() is always called on mount (see
  // MenuGridContainer), so there is no real moment where "not loading, zero
  // items" is true before the first fetch resolves. Defaulting this to
  // false was exactly what let the UI render "no items" for the one frame
  // before the mount effect's set({ loading: true }) landed.
  loading: true,
  error: null,

  fetchMenu: async () => {
    set({ loading: true, error: null });
    try {
      const token = useAuthStore.getState().token;
      // Perf fix (post-login load lag): these two reads have no data
      // dependency on each other (menu items don't need categories loaded
      // first, they're joined client-side by category_id) -- they used to
      // be sequential awaits, serializing two IPC round trips where one
      // would do. Fetched in parallel now.
      const [allCategories, allMenuItems, comboRows, comboItemRows, happyHourRows] = await Promise.all([
        invoke<{ id: string; name: string; color: string | null; sort_order: number; is_active: number }[]>(
          "list_categories_v3", { sessionToken: token }
        ),
        invoke<{
          id: string; name: string; price_cents: number; category_id: string; image_path: string | null;
          is_combo: number; combo_original_price_cents: number | null; combo_description: string | null;
          barcode: string | null; is_active: number;
        }[]>("list_menu_items_v3", { sessionToken: token }),
        // The offers built in Menu Management (combo_meals bundles + happy-hour
        // rules) used to be fetched only by menu/page.tsx's admin screen --
        // nothing on the POS order-taking side ever asked for them, so a
        // cashier had no way to sell them and no discount ever applied even
        // when adding the same items one by one. Fetched here too now, same
        // shape as menu/page.tsx's own fetch.
        invoke<{ id: string; name: string; bundle_price_cents: number }[]>("list_combo_meals_v3", { sessionToken: token }),
        invoke<{ combo_id: string; menu_item_id: string; menu_item_name: string; quantity: number; price_cents: number }[]>(
          "list_combo_meal_items_v3", { sessionToken: token }
        ),
        invoke<{ id: string; menu_item_id: string; menu_item_name: string; discount_percent: number; day_of_week: number; start_time: string; end_time: string; is_active: number }[]>(
          "list_happy_hour_rules_v3", { sessionToken: token }
        ),
      ]);

      const combos = comboRows.map((c) => ({
        id: c.id,
        name: c.name,
        bundlePriceCents: c.bundle_price_cents,
        items: comboItemRows
          .filter((ci) => ci.combo_id === c.id)
          .map((ci) => ({ menuItemId: ci.menu_item_id, name: ci.menu_item_name, quantity: ci.quantity, priceCents: ci.price_cents })),
      }));
      useComboStore.getState().setCombos(combos);

      const happyHourRules = happyHourRows.map((r) => ({
        id: r.id, menuItemId: r.menu_item_id, discountPercent: r.discount_percent,
        dayOfWeek: r.day_of_week, startTime: r.start_time, endTime: r.end_time, is_active: r.is_active,
      }));
      useHappyHourStore.getState().setRules(happyHourRules);
      const categories: Category[] = allCategories
        .filter((c) => c.is_active === 1)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((c) => ({ id: c.id, name: c.name, color: c.color, sort_order: c.sort_order }));

      // P0 perf fix (2026-07-18): this used to await list_combo_components_v3
      // once PER combo item, sequentially, inside a for...of loop -- a
      // classic N+1 (each invoke() is a real IPC round trip, and they never
      // overlapped). Fetched in parallel instead; same total work, bounded
      // by the slowest single call instead of their sum.
      const activeItems = allMenuItems.filter((i) => i.is_active === 1);
      const comboRowsByItem = await Promise.all(
        activeItems.map((item) =>
          item.is_combo
            // See ComboComponentRow's doc comment (repo.rs): this mirrors an
            // existing combo_items.combo_id/menu_items.id data-model mismatch,
            // not a fix -- it returns empty on a real install today, same as
            // the old Kysely-based query did.
            ? invoke<{ menu_item_id: string; menu_item_name: string; quantity: number }[]>(
                "list_combo_components_v3", { sessionToken: token, menuItemId: item.id }
              )
            : Promise.resolve([])
        )
      );

      const itemsWithCombo: MenuItem[] = activeItems.map((item, i) => {
        const happyHourDiscountPercent = getActiveHappyHourDiscount(item.id, happyHourRules);
        return {
          id: item.id,
          name: item.name,
          price_cents: item.price_cents,
          category_id: item.category_id,
          image_path: item.image_path,
          is_combo: item.is_combo === 1,
          combo_original_price_cents: item.combo_original_price_cents,
          combo_description: item.combo_description,
          combo_components: comboRowsByItem[i].map((r) => ({ menuItemId: r.menu_item_id, name: r.menu_item_name, qty: r.quantity })),
          barcode: item.barcode,
          happyHourDiscountPercent,
          effectivePriceCents: happyHourDiscountPercent > 0
            ? Math.round(item.price_cents * (1 - happyHourDiscountPercent / 100))
            : item.price_cents,
        };
      });

      set({ categories, menuItems: itemsWithCombo, loading: false, error: null });
    } catch (err) {
      logger.error("Failed to fetch menu", { error: String(err) });
      set({ loading: false, error: "تعذر تحميل القائمة. تحقق من اتصال الخادم." });
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
