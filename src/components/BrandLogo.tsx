// The WENZDES logo, from public/brand (real SVGs, not a letter in a box).
// `BrandMark` is the symbol alone on a light tile so it stays readable on the
// dark sidebar; `BrandLockup` is symbol + wordmark for light screens.
const base = import.meta.env.BASE_URL;

export function BrandMark({ size = 36, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.24), backgroundColor: "#F7F3EC" }}
    >
      <img src={`${base}brand/wenzdes-mark.svg`} alt="WENZDES" style={{ width: size * 0.68, height: "auto" }} draggable={false} />
    </span>
  );
}

export function BrandLockup({ height = 32, className = "" }: { height?: number; className?: string }) {
  return <img src={`${base}brand/wenzdes-lockup.svg`} alt="WENZDES" style={{ height, width: "auto" }} className={className} draggable={false} />;
}
