import type { Warehouse } from "../../lib/warehouses";

/** «المخزن» picker for a form. Shows nothing at all while the shop has one warehouse. `value` "" means the default one. */
export default function WarehouseSelect({
  warehouses,
  value,
  onChange,
  className,
}: {
  /** the shown warehouses */
  warehouses: Warehouse[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  if (warehouses.length < 2) return null;
  const selected = value || warehouses.find((w) => w.is_default)?.id || "";
  return (
    <div className={className}>
      <label className="block text-xs text-ink-400 mb-1 font-arabic">المخزن</label>
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 px-3 rounded-sm border-2 border-ink-200 text-sm font-arabic focus:outline-none focus:ring-2 focus:ring-saffron-600"
        aria-label="المخزن"
      >
        {warehouses.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </div>
  );
}
