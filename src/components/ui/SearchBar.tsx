import { IconSearch as Search } from "@tabler/icons-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export default function SearchBar({ value, onChange, placeholder = "بحث..." }: Props) {
  return (
    <div className="relative">
      <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full h-10 bg-ink-50 border border-ink-200 rounded-md pr-10 pl-3 text-sm text-ink-800 placeholder-ink-400 focus:outline-none focus:border-accent transition-colors"
      />
    </div>
  );
}
