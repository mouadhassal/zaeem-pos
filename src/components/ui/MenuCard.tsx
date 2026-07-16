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
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm hover:border-ink-600 hover:-translate-y-0.5 transition-all duration-200">
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
          <span className="text-3xl opacity-30">🍽</span>
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
