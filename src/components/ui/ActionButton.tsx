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
  primary: "bg-saffron-600 text-white hover:bg-saffron-700 active:bg-saffron-800",
  secondary: "bg-white text-ink-700 border border-ink-200 hover:bg-ink-50 active:bg-ink-100",
  danger: "bg-danger-soft text-danger border border-danger/30 hover:bg-danger/10 active:bg-danger/20",
  ghost: "text-ink-500 hover:text-ink-700 hover:bg-ink-100",
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
