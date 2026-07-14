import { Package } from "lucide-react";

interface Props {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
}

export default function EmptyState({ title = "لا توجد عناصر", description = "", icon }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-16 h-16 rounded-md bg-slate-100 border border-slate-200 flex items-center justify-center mb-4">
        {icon || <Package className="w-8 h-8 text-slate-400" />}
      </div>
      <p className="text-base font-medium text-slate-800 mb-1">{title}</p>
      {description && <p className="text-sm text-slate-500">{description}</p>}
    </div>
  );
}
