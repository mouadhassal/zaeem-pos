import type { Icon } from "@tabler/icons-react";

interface Props {
  label: string;
  icon?: Icon;
  active: boolean;
  onClick: () => void;
}

export default function CategoryChip({ label, icon: IconComp, active, onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-[background-color,color,border-color,transform] shrink-0 active:scale-95 ${
        active
          ? "bg-ink-900 text-white"
          : "bg-surface text-text-3 border border-ink-200 hover:bg-surface-alt"
      }`}
      style={{ minHeight: 44, minWidth: 44 }}
    >
      {IconComp && <IconComp size={18} stroke={1.75} />}
      <span>{label}</span>
    </button>
  );
}
