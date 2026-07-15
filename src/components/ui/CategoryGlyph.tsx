import { getCategoryStyle } from "./CategoryConfig";

interface Props {
  categoryName: string;
  photoUrl?: string | null | undefined;
  className?: string;
}

export default function CategoryGlyph({ categoryName, photoUrl, className = "" }: Props) {
  const style = getCategoryStyle(categoryName);

  if (photoUrl) {
    return (
      <div className={`w-full h-[62px] shrink-0 overflow-hidden ${className}`}>
        <img src={photoUrl} alt="" className="w-full h-full object-cover" />
      </div>
    );
  }

  const Icon = style.icon;

  return (
    <div
      className={`w-full h-[62px] shrink-0 flex items-center justify-center ${className}`}
      style={{ backgroundColor: style.wash }}
    >
      <Icon size={28} stroke={1.75} color={style.glyphColor} style={{ opacity: 0.7 }} />
    </div>
  );
}
