import { getCategoryStyle } from "./CategoryConfig";

interface Props {
  categoryName: string;
  photoUrl?: string | null | undefined;
  className?: string;
  /** Photo-or-glyph fills the SAME geometry, zero layout shift regardless of
   * which one renders. */
  heightPx?: number;
  iconSizePx?: number;
}

export default function CategoryGlyph({ categoryName, photoUrl, className = "", heightPx = 90, iconSizePx = 24 }: Props) {
  const style = getCategoryStyle(categoryName);

  if (photoUrl) {
    return (
      <div className={`w-full shrink-0 overflow-hidden ${className}`} style={{ height: heightPx }}>
        <img src={photoUrl} alt="" className="w-full h-full object-cover" />
      </div>
    );
  }

  const Icon = style.icon;

  return (
    <div
      className={`w-full shrink-0 flex items-center justify-center ${className}`}
      style={{ height: heightPx, backgroundImage: `linear-gradient(135deg, ${style.wash}, ${style.washDeep})` }}
    >
      <Icon size={iconSizePx} stroke={2} color={style.glyphColor} />
    </div>
  );
}
