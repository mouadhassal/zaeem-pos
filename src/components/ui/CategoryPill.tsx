interface Props {
  name: string;
  isActive: boolean;
  onClick: () => void;
}

export default function CategoryPill({ name, isActive, onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className={`px-5 py-2.5 rounded-full font-arabic font-medium text-sm whitespace-nowrap transition-colors ${
        isActive
          ? "bg-emerald-600 text-white shadow-sm"
          : "bg-white text-slate-500 border border-slate-200 hover:border-emerald-300 hover:text-emerald-600"
      }`}
    >
      {name}
    </button>
  );
}
