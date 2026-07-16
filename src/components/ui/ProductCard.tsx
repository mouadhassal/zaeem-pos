import { ShoppingCart, Plus } from "lucide-react";
import { useCurrency } from "../../hooks/useCurrency";

interface Props {
  id: number | string;
  name: string;
  price: number;
  image?: string;
  category?: string;
  isCombo?: boolean;
  onAdd: (id: number | string) => void;
}

export default function ProductCard({ id, name, price, image, category, isCombo, onAdd }: Props) {
  const { fmt } = useCurrency();
  return (
    <div
      className="group relative bg-white border border-ink-200 rounded-md overflow-hidden hover:border-saffron-400 transition-colors cursor-pointer"
      onClick={() => onAdd(id)}
    >
      <div className="aspect-[4/3] bg-ink-100 relative overflow-hidden">
        {image ? (
          <img src={image} alt={name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ShoppingCart className="w-10 h-10 text-ink-300" />
          </div>
        )}
        {isCombo && (
          <span className="absolute top-2 right-2 px-2 py-0.5 bg-amber-400 text-amber-900 text-[10px] font-bold rounded-sm">
            كومبو
          </span>
        )}
        <div className="absolute inset-0 bg-saffron-600/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <Plus className="w-8 h-8 text-white" />
        </div>
      </div>
      <div className="p-2.5 space-y-1">
        <h3 className="text-sm font-medium text-ink-800 leading-tight line-clamp-1">{name}</h3>
        <p className="text-xs text-ink-400">{category}</p>
        <p className="text-base font-bold text-saffron-700">{fmt(price)}</p>
      </div>
    </div>
  );
}
