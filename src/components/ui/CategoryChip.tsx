import type { Icon } from "@tabler/icons-react";

interface Props {
  label: string;
  icon?: Icon;
  active: boolean;
  onClick: () => void;
  /** In a grid of several per row: icon over a short, wrapping name, so a long list needs no scrolling. */
  compact?: boolean;
  testid?: string;
}

export default function CategoryChip({ label, icon: IconComp, active, onClick, compact = false, testid }: Props) {
  const tone = active ? "bg-ink-900 text-white" : "bg-surface text-text-3 border border-ink-200 hover:bg-surface-alt";
  if (compact) {
    return (
      <button
        onClick={onClick}
        data-testid={testid}
        title={label}
        className={`flex flex-col items-center justify-center gap-0.5 px-1 py-1 rounded-lg text-[11px] leading-tight font-medium transition-[background-color,color,border-color,transform] active:scale-95 min-w-0 ${tone}`}
        style={{ minHeight: 44 }}
      >
        {IconComp && <IconComp size={16} stroke={1.75} />}
        <span className="w-full text-center break-words line-clamp-2">{label}</span>
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-[background-color,color,border-color,transform] shrink-0 active:scale-95 ${tone}`}
      style={{ minHeight: 44, minWidth: 44 }}
    >
      {IconComp && <IconComp size={18} stroke={1.75} />}
      <span>{label}</span>
    </button>
  );
}
