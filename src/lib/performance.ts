import { logger } from "./logger";

const MEMORY_WARN_THRESHOLD_MB = 500;
const MEMORY_LOG_INTERVAL_MS = 60 * 60 * 1000;

export function getMemoryUsage(): { heapUsedMB: number; heapTotalMB: number } {
  if (
    typeof window !== "undefined" &&
    "memory" in performance &&
    (performance as unknown as { memory: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
  ) {
    const mem = (performance as unknown as {
      memory: { usedJSHeapSize: number; totalJSHeapSize: number };
    }).memory;
    return {
      heapUsedMB: Math.round(mem.usedJSHeapSize / 1024 / 1024),
      heapTotalMB: Math.round(mem.totalJSHeapSize / 1024 / 1024),
    };
  }
  return { heapUsedMB: 0, heapTotalMB: 0 };
}

export function logMemoryUsage(): void {
  const { heapUsedMB, heapTotalMB } = getMemoryUsage();
  logger.info("Memory snapshot", {
    module: "performance",
    heapUsedMB,
    heapTotalMB,
  });

  if (heapUsedMB > MEMORY_WARN_THRESHOLD_MB) {
    logger.warn("High memory usage detected", {
      module: "performance",
      heapUsedMB,
      threshold: MEMORY_WARN_THRESHOLD_MB,
      suggestion: "Restart the app to free memory",
    });
  }
}

let memoryTimer: ReturnType<typeof setInterval> | null = null;

export function startMemoryMonitoring(): void {
  if (memoryTimer) return;
  logMemoryUsage();
  memoryTimer = setInterval(logMemoryUsage, MEMORY_LOG_INTERVAL_MS);
}

export function stopMemoryMonitoring(): void {
  if (memoryTimer) {
    clearInterval(memoryTimer);
    memoryTimer = null;
  }
}

export function measureStartup(): () => number {
  const start = performance.now();
  return () => {
    const duration = performance.now() - start;
    logger.info("Startup complete", {
      module: "performance",
      durationMs: Math.round(duration),
      target: 3000,
    });
    return duration;
  };
}

export function trackOperation(name: string): {
  end: (meta?: Record<string, unknown>) => number;
} {
  const start = performance.now();
  return {
    end: (meta?: Record<string, unknown>) => {
      const duration = performance.now() - start;
      logger.info(`Operation: ${name}`, {
        module: "performance",
        durationMs: Math.round(duration),
        ...meta,
      });
      return duration;
    },
  };
}

const FPS_SAMPLES: number[] = [];
let fpsInterval: ReturnType<typeof setInterval> | null = null;

export function startFpsMonitor(cb?: (fps: number) => void): void {
  let lastTime = performance.now();
  let frames = 0;

  if (fpsInterval) return;

  const measure = () => {
    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      const fps = Math.round((frames * 1000) / (now - lastTime));
      FPS_SAMPLES.push(fps);
      if (FPS_SAMPLES.length > 60) FPS_SAMPLES.shift();

      if (fps < 30) {
        logger.warn("Low FPS detected", { module: "performance", fps });
      }

      cb?.(fps);
      frames = 0;
      lastTime = now;
    }
    requestAnimationFrame(measure);
  };

  requestAnimationFrame(measure);
}

export function stopFpsMonitor(): void {
  if (fpsInterval) {
    clearInterval(fpsInterval);
    fpsInterval = null;
  }
}

export function getAverageFps(): number {
  if (FPS_SAMPLES.length === 0) return 0;
  return Math.round(
    FPS_SAMPLES.reduce((a, b) => a + b, 0) / FPS_SAMPLES.length
  );
}

export class ImageCache {
  private cache = new Map<string, string>();
  private maxSize: number;
  private currentSize = 0;

  constructor(maxSizeMB = 100) {
    this.maxSize = maxSizeMB * 1024 * 1024;
  }

  get(key: string): string | undefined {
    const value = this.cache.get(key);
    if (value) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, dataUrl: string): void {
    const size = dataUrl.length * 2;
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value;
      if (oldest) {
        const old = this.cache.get(oldest);
        this.cache.delete(oldest);
        if (old) {
          this.currentSize -= old.length * 2;
        }
      }
    }
    this.cache.set(key, dataUrl);
    this.currentSize += size;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
  }

  get size(): number {
    return this.cache.size;
  }

  get estimatedSizeMB(): number {
    return Math.round(this.currentSize / 1024 / 1024);
  }

  static getFileExtension(url: string): string {
    const ext = url.split(".").pop()?.toLowerCase();
    return ext === "webp" ? "webp" : "jpg";
  }
}

export const imageCache = new ImageCache(100);
