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
      className={`flex items-center gap-2 px-4 py-2 rounded-[12px] text-sm font-medium transition-all shrink-0 active:scale-95 ${
        active
          ? "bg-ink-900 text-white shadow-sh-1"
          : "bg-surface text-text-3 shadow-sh-1 hover:bg-surface-alt"
      }`}
      style={{ minHeight: 40, minWidth: 44 }}
    >
      {IconComp && <IconComp size={18} stroke={1.75} />}
      <span>{label}</span>
    </button>
  );
}
