// Loads the warehouses of the branch (see warehouses.ts for the types and the plain helpers).
import { useCallback, useEffect, useState } from "react";
import { invoke } from "./invoke";
import { useAuthStore } from "../stores/authStore";
import { shownWarehouses, type StockCell, type Warehouse } from "./warehouses";

/** The branch's warehouses. A failed load counts as "one warehouse" so the page stays as it always was. */
export function useWarehouses(refreshKey = 0) {
  const token = useAuthStore((s) => s.token);
  const [all, setAll] = useState<Warehouse[]>([]);
  const reload = useCallback(async () => {
    try {
      setAll(await invoke<Warehouse[]>("list_warehouses_v3", { sessionToken: token }));
    } catch {
      setAll([]);
    }
  }, [token]);
  useEffect(() => {
    reload();
  }, [reload, refreshKey]);
  const shown = shownWarehouses(all);
  return { all, shown, multi: shown.length >= 2, reload };
}

/** Per ingredient and warehouse quantities; only loaded when there are two or more warehouses. */
export function useWarehouseStock(multi: boolean, refreshKey = 0) {
  const token = useAuthStore((s) => s.token);
  const [cells, setCells] = useState<StockCell[]>([]);
  useEffect(() => {
    if (!multi) {
      setCells([]);
      return;
    }
    invoke<StockCell[]>("list_warehouse_stock_v3", { sessionToken: token })
      .then(setCells)
      .catch(() => setCells([]));
  }, [token, multi, refreshKey]);
  return cells;
}
