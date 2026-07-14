import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  title?: string;
}

const variantStyles = {
  primary: "bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800",
  secondary: "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 active:bg-slate-100",
  danger: "bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 active:bg-red-200",
  ghost: "text-slate-500 hover:text-slate-700 hover:bg-slate-100",
};

export default function ActionButton({
  children,
  onClick,
  variant = "primary",
  type = "button",
  disabled = false,
  className = "",
  title,
}: Props) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-sm text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${variantStyles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
