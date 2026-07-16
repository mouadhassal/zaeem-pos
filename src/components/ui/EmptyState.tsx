import { Package } from "lucide-react";

interface Props {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
}

export default function EmptyState({ title = "لا توجد عناصر", description = "", icon }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-16 h-16 rounded-md bg-ink-100 border border-ink-200 flex items-center justify-center mb-4">
        {icon || <Package className="w-8 h-8 text-ink-400" />}
      </div>
      <p className="text-base font-medium text-ink-800 mb-1">{title}</p>
      {description && <p className="text-sm text-ink-500">{description}</p>}
    </div>
  );
}
