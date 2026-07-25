interface Props {
  name: string;
  priceCents: number;
  imagePath?: string | null;
  categoryColor?: string | null;
  onAdd: () => void;
}

export default function MenuCard({
  name,
  priceCents,
  imagePath,
  categoryColor,
  onAdd,
}: Props) {
  return (
    <div className="bg-white border border-ink-200 rounded-md overflow-hidden hover:border-ink-600 hover:-translate-y-0.5 transition-all duration-200">
      <div
        className="h-28 bg-white flex items-center justify-center overflow-hidden"
        style={categoryColor ? { borderTop: `3px solid ${categoryColor}` } : undefined}
      >
        {imagePath ? (
          <img
            src={imagePath}
            alt={name}
            className="w-full h-full object-cover"
          />
        ) : (
          <svg className="w-8 h-8 text-ink-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="9" cy="21" r="1" />
            <circle cx="20" cy="21" r="1" />
            <path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6" />
          </svg>
        )}
      </div>
      <div className="p-3 space-y-2">
        <h3 className="text-ink-900 font-medium text-sm truncate">{name}</h3>
        <div className="flex items-center justify-between">
          <span className="text-saffron-600 font-bold text-sm font-mono">
            {new Intl.NumberFormat("ar-SA", {
              style: "currency",
              currency: "SAR",
            }).format(priceCents / 100)}
          </span>
          <button
            onClick={onAdd}
            className="h-8 w-8 rounded-lg bg-saffron-600 text-white text-sm flex items-center justify-center hover:bg-saffron-700 transition-colors"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}
