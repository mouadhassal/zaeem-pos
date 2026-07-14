import { useEffect, useState } from "react";
import { useMenuStore, useFilteredMenuItems } from "../stores/menuStore";
import { useCartStore } from "../stores/cartStore";
import SearchBar from "./ui/SearchBar";
import VirtualizedMenuGrid from "./ui/VirtualizedMenuGrid";
import type { MenuItem } from "../stores/menuStore";

export default function MenuGrid() {
  const {
    searchQuery,
    fetchMenu,
    setSearchQuery,
  } = useMenuStore();
  const addItem = useCartStore((s) => s.addItem);
  const filteredItems = useFilteredMenuItems();
  const [flashId, setFlashId] = useState<string | null>(null);

  useEffect(() => {
    fetchMenu();
  }, [fetchMenu]);

  const handleAdd = (item: MenuItem) => {
    const savings = item.is_combo && item.combo_original_price_cents
      ? item.combo_original_price_cents - item.price_cents
      : 0;
    addItem({
      menuItemId: item.id,
      name: item.name,
      quantity: 1,
      unitPriceCents: item.price_cents,
      modifiers: [],
      notes: "",
      isCombo: item.is_combo,
      comboOriginalPriceCents: item.combo_original_price_cents ?? 0,
      comboComponents: item.combo_components,
      savingsCents: savings,
    });
    setFlashId(item.id);
    setTimeout(() => setFlashId(null), 300);
  };

  return (
    <div className="flex flex-col h-full">
      <SearchBar
        value={searchQuery}
        onChange={setSearchQuery}
      />
      <VirtualizedMenuGrid
        items={filteredItems}
        columns={4}
        gap={12}
        itemHeight={200}
        onAdd={handleAdd}
        flashId={flashId}
      />
    </div>
  );
}
