import { unitChoices } from "../../lib/inventoryUnits";

/** Unit picker for one ingredient: its own stock unit (value ""), the other standard units of the
 *  same kind (150 g for an ingredient kept in kg) and its packs (carton, sack ...). */
export default function UnitSelect({
  stockUnit,
  packs,
  value,
  onChange,
  className,
}: {
  stockUnit: string;
  packs: { name_ar: string; factor_to_stock_unit: number }[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const choices = unitChoices(stockUnit, packs);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className ?? "h-10 px-2 rounded-sm border-2 border-ink-200 text-sm font-arabic focus:outline-none focus:ring-2 focus:ring-saffron-600"}
      aria-label="الوحدة"
    >
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
