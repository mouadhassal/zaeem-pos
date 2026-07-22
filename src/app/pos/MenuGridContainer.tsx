import { useEffect, useState, useMemo, type ComponentProps } from "react";
import { IconSearch, IconLayoutGrid } from "@tabler/icons-react";
import { useMenuStore, useFilteredMenuItems } from "../../stores/menuStore";
import { useCartStore } from "../../stores/cartStore";
import { useAuthStore } from "../../stores/authStore";
import { useComboStore, type Combo } from "../../stores/comboStore";
import { useMenuItemPhoto } from "../../hooks/useMenuItemPhoto";
import { getCategoryStyle } from "../../components/ui/CategoryConfig";
import SearchBar from "../../components/ui/SearchBar";
import CategoryChip from "../../components/ui/CategoryChip";
import ItemCard from "../../components/ui/ItemCard";
import Numpad from "../../components/ui/Numpad";

// list_menu_items_v3 returns "HAS_PHOTO" (not a real path/URL, see its
// P0-fix doc comment) when an item has a photo, null otherwise -- this
// wrapper resolves the real photo lazily via useMenuItemPhoto so the grid
// renders instantly with glyphs and photos fill in as each one loads.
function LazyItemCard(props: Omit<ComponentProps<typeof ItemCard>, "photoUrl"> & { itemId: string; hasPhoto: boolean }) {
  const token = useAuthStore((s) => s.token);
  const { itemId, hasPhoto, ...rest } = props;
  const photoUrl = useMenuItemPhoto(itemId, hasPhoto, token);
  return <ItemCard {...rest} photoUrl={photoUrl} />;
}


interface Props {
  currencySymbol: string;
  onAddItem: (item: {
    menuItemId: string;
    name: string;
    categoryName?: string;
    quantity: number;
    unitPriceCents: number;
    notes: string;
    isCombo?: boolean;
    comboOriginalPriceCents?: number;
    comboComponents?: any[];
    savingsCents?: number;
    comboId?: string;
  }) => void;
  showNumpad: boolean;
}

export default function MenuGridContainer({ currencySymbol, onAddItem, showNumpad }: Props) {
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);

  const [searchValue, setSearchValue] = useState("");

  const {
    categories,
    fetchMenu,
    loading,
  } = useMenuStore();

  const filteredByStore = useFilteredMenuItems();
  const allItems = useMemo(() =>
    filteredByStore.filter((item) => {
      if (searchValue && !item.name.includes(searchValue)) return false;
      return true;
    }),
  [filteredByStore, searchValue]);

  const filteredItems = useMemo(() => {
    if (!activeCategory) return allItems;
    const cat = categories.find((c) => c.name === activeCategory);
    return cat ? allItems.filter((i) => i.category_id === cat.id) : allItems;
  }, [allItems, activeCategory, categories]);

  const cartItems = useCartStore((s) => s.items);
  const getQty = (itemId: string) =>
    cartItems.reduce((sum, i) => sum + (i.menuItemId === itemId ? i.quantity : 0), 0);

  const combos = useComboStore((s) => s.combos);

  useEffect(() => {
    fetchMenu();
  }, [fetchMenu]);

  const handleAdd = (item: (typeof allItems)[0]) => {
    const cat = categories.find((c) => c.id === item.category_id);
    const comboSavings = item.is_combo && item.combo_original_price_cents
      ? item.combo_original_price_cents - item.price_cents
      : 0;
    // Happy-hour savings are on top of (not instead of) the legacy per-item
    // combo savings above -- effectivePriceCents already has the happy-hour
    // discount baked in, so the difference vs. price_cents is exactly what
    // the customer is saving on this item right now.
    const happyHourSavings = item.price_cents - item.effectivePriceCents;
    onAddItem({
      menuItemId: item.id,
      name: item.name,
      categoryName: cat?.name || "",
      quantity: 1,
      unitPriceCents: item.effectivePriceCents,
      notes: "",
      isCombo: item.is_combo,
      ...(item.combo_original_price_cents != null
        ? { comboOriginalPriceCents: item.combo_original_price_cents }
        : {}),
      comboComponents: item.combo_components,
      savingsCents: comboSavings + happyHourSavings,
    });
  };

  // A combo bundle (built in Menu Management, e.g. "3 for the price of 1")
  // is sold as its component menu items, all tagged with one shared comboId,
  // each priced down proportionally so the group's total equals
  // combo.bundlePriceCents -- not as one opaque line item, so the kitchen
  // ticket and receipt still show exactly what was ordered.
  const handleAddCombo = (combo: Combo) => {
    const normalTotalCents = combo.items.reduce((sum, ci) => sum + ci.priceCents * ci.quantity, 0);
    const ratio = normalTotalCents > 0 ? combo.bundlePriceCents / normalTotalCents : 1;
    const comboId = `combo-${combo.id}-${Date.now()}`;
    for (const ci of combo.items) {
      onAddItem({
        menuItemId: ci.menuItemId,
        name: ci.name,
        categoryName: `عرض: ${combo.name}`,
        quantity: ci.quantity,
        unitPriceCents: Math.round(ci.priceCents * ratio),
        notes: "",
        comboId,
        savingsCents: Math.max(0, ci.priceCents - Math.round(ci.priceCents * ratio)) * ci.quantity,
      });
    }
  };

  const handleRemove = (item: (typeof allItems)[0]) => {
    const existing = cartItems.find((i) => i.menuItemId === item.id);
    if (existing) {
      useCartStore.getState().updateQuantity(existing.id, -1);
    }
  };

  // A real restaurant menu is 40+ items; the cashier scrolls the grid
  // (already `overflow-y-auto` below), so there is no reason to truncate
  // the list to a fixed count -- that just hides items that exist.
  const visibleItems = filteredItems;
  // "No items yet because still loading" and "genuinely zero items" must
  // never render the same message -- this was the actual bug behind the
  // post-login "لا توجد أصناف" flash: isEmpty used to fire the instant
  // menuItems was [], which is also true for every millisecond before the
  // first fetch resolves.
  const isInitialLoading = loading && allItems.length === 0;
  const isEmpty = !loading && visibleItems.length === 0;

  const countByCategoryId = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of allItems) {
      map.set(item.category_id, (map.get(item.category_id) ?? 0) + 1);
    }
    return map;
  }, [allItems]);

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-line">
        <button
          onClick={() => setShowSearch((v) => !v)}
          className="w-11 h-[34px] rounded-[9px] bg-surface-alt flex items-center justify-center text-text-muted transition-all active:scale-95"
          style={{ minWidth: 44 }}
        >
          <IconSearch className="w-4 h-4" stroke={1.75} />
        </button>

        <div className="flex gap-1.5 overflow-x-auto no-scrollbar flex-1">
          <CategoryChip
            label={`الكل · ${allItems.length}`}
            icon={IconLayoutGrid}
            active={activeCategory === null}
            onClick={() => setActiveCategory(null)}
          />
          {categories.map((cat) => (
            <CategoryChip
              key={cat.id}
              label={`${cat.name} · ${countByCategoryId.get(cat.id) ?? 0}`}
              icon={getCategoryStyle(cat.name).icon}
              active={activeCategory === cat.name}
              onClick={() => setActiveCategory(activeCategory === cat.name ? null : cat.name)}
            />
          ))}
        </div>
      </div>

      {showSearch && (
        <div className="px-3 py-2 border-b border-line">
          <SearchBar value={searchValue} onChange={setSearchValue} />
        </div>
      )}

      {combos.length > 0 && (
        <div className="px-3 pt-2 pb-1 shrink-0 border-b border-line">
          <div className="text-[11px] font-semibold text-text-muted mb-1.5">العروض</div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar">
            {combos.map((combo) => (
              <button
                key={combo.id}
                onClick={() => handleAddCombo(combo)}
                className="shrink-0 rounded-[10px] px-3 py-2 text-start transition-all active:scale-[0.98]"
                style={{ background: "#FFF4EC", border: "1px solid #F04E23", minWidth: 160 }}
              >
                <div className="text-[12px] font-medium text-text truncate">{combo.name}</div>
                <div className="tabular text-[12px] font-semibold" style={{ color: "#F04E23" }} dir="ltr">
                  {(combo.bundlePriceCents / 100).toLocaleString("en-US")} {currencySymbol}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3">
        {isInitialLoading ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="h-28 rounded-[12px] bg-surface-alt animate-pulse" />
            ))}
          </div>
        ) : isEmpty ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            {searchValue ? "ما في أصناف تطابق البحث" : "ما في أصناف متاحة"}
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
            {visibleItems.map((item) => {
              const cat = categories.find((c) => c.id === item.category_id);
              return (
                <LazyItemCard
                  key={item.id}
                  itemId={item.id}
                  hasPhoto={item.image_path === "HAS_PHOTO"}
                  name={item.name}
                  priceCents={item.effectivePriceCents}
                  {...(item.happyHourDiscountPercent > 0
                    ? { originalPriceCents: item.price_cents, badge: `🕐 -${item.happyHourDiscountPercent}%` }
                    : {})}
                  categoryName={cat?.name || ""}
                  quantity={getQty(item.id)}
                  currencySymbol={currencySymbol}
                  onAdd={() => handleAdd(item)}
                  onRemove={() => handleRemove(item)}
                />
              );
            })}
          </div>
        )}
      </div>

      {showNumpad && (
        <div className="border-t border-line bg-surface">
          <Numpad
            onDigit={(d) => setSearchValue((prev) => prev + d)}
            onBackspace={() => setSearchValue((prev) => prev.slice(0, -1))}
            onClear={() => setSearchValue("")}
          />
        </div>
      )}
    </div>
  );
}
