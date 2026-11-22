import { useCallback, useEffect, useState } from "react";

/**
 * Loads one tab's data. `load` never throws (the parts that fail come back null, see `settle`), so the tab
 * only has a "loading" and a "ready" state. Reloads when `deps` change (the period) or `reload()` is called.
 */
export function useDashLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, reload };
}
