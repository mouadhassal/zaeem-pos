import { getCategoryStyle } from "./CategoryConfig";

interface Props {
  categoryName: string;
  photoUrl?: string | null | undefined;
  className?: string;
  /** DESIGN_V3 §2: photo-or-glyph fills the SAME geometry, zero layout shift
   * regardless of which one renders. Defaults to 132px (the "~120-140px"
   * photos-first menu item card image area). */
  heightPx?: number;
}

export default function CategoryGlyph({ categoryName, photoUrl, className = "", heightPx = 132 }: Props) {
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
      style={{ height: heightPx, backgroundColor: style.wash }}
    >
      <Icon size={Math.round(heightPx * 0.32)} stroke={1.5} color={style.glyphColor} style={{ opacity: 0.75 }} />
    </div>
  );
}
