import { useEffect, useState, useMemo } from "react";
import { IconSearch } from "@tabler/icons-react";
import { useMenuStore, useFilteredMenuItems } from "../../stores/menuStore";
import { useCartStore } from "../../stores/cartStore";
import SearchBar from "../../components/ui/SearchBar";
import CategoryChip from "../../components/ui/CategoryChip";
import ItemCard from "../../components/ui/ItemCard";
import Numpad from "../../components/ui/Numpad";


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

  useEffect(() => {
    fetchMenu();
  }, [fetchMenu]);

  const handleAdd = (item: (typeof allItems)[0]) => {
    const cat = categories.find((c) => c.id === item.category_id);
    const savings = item.is_combo && item.combo_original_price_cents
      ? item.combo_original_price_cents - item.price_cents
      : 0;
    onAddItem({
      menuItemId: item.id,
      name: item.name,
      categoryName: cat?.name || "",
      quantity: 1,
      unitPriceCents: item.price_cents,
      notes: "",
      isCombo: item.is_combo,
      ...(item.combo_original_price_cents != null
        ? { comboOriginalPriceCents: item.combo_original_price_cents }
        : {}),
      comboComponents: item.combo_components,
      savingsCents: savings,
    });
  };

  const handleRemove = (item: (typeof allItems)[0]) => {
    const existing = cartItems.find((i) => i.menuItemId === item.id);
    if (existing) {
      useCartStore.getState().updateQuantity(existing.id, -1);
    }
  };

  const visibleItems = filteredItems.slice(0, 12);
  const isEmpty = visibleItems.length === 0;

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
            label="الكل"
            active={activeCategory === null}
            onClick={() => setActiveCategory(null)}
          />
          {categories.map((cat) => (
            <CategoryChip
              key={cat.id}
              label={cat.name}
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

      <div className="flex-1 overflow-y-auto p-3">
        {isEmpty ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            {searchValue ? "ما في أصناف تطابق البحث" : "ما في أصناف متاحة"}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {visibleItems.map((item) => {
              const cat = categories.find((c) => c.id === item.category_id);
              return (
                <ItemCard
                  key={item.id}
                  name={item.name}
                  priceCents={item.price_cents}
                  categoryName={cat?.name || ""}
                  photoUrl={item.image_path}
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
