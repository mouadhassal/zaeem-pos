interface Props {
  platforms: { id: string; name: string }[];
  /** The chosen delivery app, null = direct. */
  value: string | null;
  onChange: (platformId: string | null) => void;
}

/**
 * Where a takeaway or delivery order came from: "مباشر" or one of the owner's delivery apps.
 * Renders nothing when the owner has no active app, so the till looks as it always did.
 */
export default function OrderSourcePicker({ platforms, value, onChange }: Props) {
  if (platforms.length === 0) return null;
  const chip = (active: boolean) =>
    `h-7 px-2.5 rounded-[7px] text-xs font-bold font-arabic whitespace-nowrap transition-colors ${active ? "bg-accent text-white" : "bg-surface-alt text-text-3 hover:bg-line"}`;
  return (
    <div className="flex items-center gap-1 shrink-0" data-testid="order-source" role="group" aria-label="مصدر الطلب">
      <span className="text-[11px] font-arabic text-text-3">المصدر:</span>
      <button type="button" className={chip(value === null)} onClick={() => onChange(null)} data-testid="order-source-direct">
        مباشر
      </button>
      {platforms.map((p) => (
        <button key={p.id} type="button" className={chip(value === p.id)} onClick={() => onChange(p.id)} data-testid={`order-source-${p.id}`}>
          {p.name}
        </button>
      ))}
    </div>
  );
}
