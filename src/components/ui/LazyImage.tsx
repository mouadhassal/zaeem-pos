import { useRef, useEffect, useState } from "react";
import { imageCache } from "../../lib/performance";

interface Props {
  src: string;
  alt: string;
  className?: string;
  fallback?: string;
}

export default function LazyImage({ src, alt, className, fallback = "🍔" }: Props) {
  const imgRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(() => imageCache.has(src));
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = imgRef.current;
    if (!el || loaded) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [loaded]);

  useEffect(() => {
    if (!visible || loaded) return;

    const img = new Image();
    img.onload = () => {
      imageCache.set(src, src);
      setLoaded(true);
    };
    img.onerror = () => setLoaded(false);
    img.src = src;
  }, [visible, src, loaded]);

  return (
    <div ref={imgRef} className={className ?? ""}>
      {loaded ? (
        <img
          src={src}
          alt={alt}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      ) : (
        <span className="text-4xl">{fallback}</span>
      )}
    </div>
  );
}
