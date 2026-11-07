import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { openMarketplace } from "../../lib/marketplace";
import { useAuthStore } from "../../stores/authStore";
import { useMarketStore } from "../../stores/marketStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney } from "../../lib/money";
import { btnGhost, btnPrimary } from "../payroll/ui";
import type { StockRow } from "./StockTab";

interface MarketProduct {
  supplier_product_id: string;
  name: string;
  unit: string | null;
  price_cents: number;
  stock_qty: number;
  is_active: boolean;
  linked_menu_item_id: string | null;
  linked_name: string | null;
  suggested_menu_item_id: string | null;
  suggested_name: string | null;
}
interface MarketOrderItem { order_item_id: string; supplier_product_id: string | null; product_name: string; unit: string | null; qty: number; linked_menu_item_id: string | null; linked_name: string | null }
interface MarketOrder { order_id: string; buyer_name: string | null; status: string | null; placed_at: string | null; total_cents: number; delivery_address: string | null; items: MarketOrderItem[] }
interface MarketState { is_supplier: boolean; products: MarketProduct[]; orders: MarketOrder[] }

const STATUS: Record<string, string> = { confirmed: "مقبول", picked_up: "خرج للتوصيل", delivered: "سُلِّم" };

/**
 * For a shop that also sells through the WENZDES Marketplace: link each marketplace product to the product on
 * the shelf, and the two stocks follow each other. Customer orders you accept leave the shelf; what the shelf
 * counts is what the marketplace shows. Buying from other suppliers needs no setup (see Settings > التفضيلات).
 */
export default function MarketTab({ onChanged }: { onChanged: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const sync = useMarketStore((s) => s.status);
  const [state, setState] = useState<MarketState | null>(null);
  const [mine, setMine] = useState<StockRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [s, products] = await Promise.all([
        invoke<MarketState>("supplier_market_state_v3", { sessionToken: token }),
        invoke<StockRow[]>("list_product_stock_v3", { sessionToken: token, search: null, onlyLow: false, includeUntracked: true }),
      ]);
      setState(s);
      setMine(products);
    } catch (e) {
      setError(realErrorText(e));
    }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const link = async (supplierProductId: string, menuItemId: string | null) => {
    setBusy(supplierProductId);
    try {
      await invoke("link_supplier_product_v3", { sessionToken: token, supplierProductId, menuItemId });
      await load();
      onChanged();
    } catch (e) {
      toast.error(realErrorText(e));
    } finally {
      setBusy(null);
    }
  };

  const apply = async (orderId: string) => {
    setBusy(orderId);
    try {
      const done = await invoke<boolean>("apply_supplier_order_v3", { sessionToken: token, orderId });
      toast.success(done ? "خُصمت الطلبية من المخزون ✓" : "كانت الطلبية مخصومة سابقاً");
      await load();
      onChanged();
    } catch (e) {
      toast.error(realErrorText(e));
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setBusy("sync");
    try {
      const out = await invoke<{ applied_orders: number; published: number; error: string | null }>("supplier_market_sync_v3", { sessionToken: token, autoApply: true });
      if (out.error) toast.error(out.error);
      else toast.success(`خُصمت ${out.applied_orders} طلبية، ونُشر مخزون ${out.published} منتج ✓`);
      await load();
      onChanged();
    } catch (e) {
      toast.error(realErrorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="rounded-md border border-ink-200 bg-white p-6 space-y-3 max-w-2xl" data-testid="market-error">
        <p className="font-arabic text-danger">{error}</p>
        <div className="flex gap-2"><button className={btnPrimary} onClick={() => void load()}>إعادة المحاولة</button><button className={btnGhost} onClick={() => void openMarketplace()}>افتح السوق</button></div>
      </div>
    );
  }
  if (!state) return <p className="text-ink-500 font-arabic" data-testid="market-loading">جارٍ تحميل بيانات السوق…</p>;

  if (!state.is_supplier) {
    return (
      <div className="rounded-md border border-ink-200 bg-white p-6 space-y-3 max-w-2xl font-arabic" data-testid="market-not-supplier">
        <h2 className="font-bold text-ink-900">السوق</h2>
        <p className="text-sm text-ink-700">
          هذا الحساب غير مسجَّل كمورّد في سوق WENZDES. إن كنت تشتري من الموردين فلا تحتاج إعداداً هنا: ما يصلك من طلباتك يُضاف إلى المخزون تلقائياً حين يتطابق مع موادك ومنتجاتك، وما لا يتطابق يظهر في الجرس لتراجعه.
        </p>
        <p className="text-sm text-ink-700">لتبيع على السوق، سجّل كمورّد من موقع السوق بحسابك ثم عُد إلى هنا لتربط منتجاتك.</p>
        <button className={btnPrimary} onClick={() => void openMarketplace()} data-testid="market-open">افتح السوق وسجّل الدخول</button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="market-tab">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-ink-200 bg-white p-4 font-arabic">
        <div className="text-sm text-ink-700">
          {sync.ordersNeedLinks > 0 ? <b className="text-danger">{sync.ordersNeedLinks} طلبية بانتظار ربط منتجاتها. </b> : null}
          يعمل الربط كل دقيقتين: طلبات عملائك المقبولة تُخصم من الرف، وما على الرف يظهر في السوق.
        </div>
        <div className="flex gap-2">
          <button className={btnGhost} onClick={() => void openMarketplace()}>افتح السوق</button>
          <button className={btnPrimary} onClick={() => void syncNow()} disabled={busy === "sync"} data-testid="market-sync">{busy === "sync" ? "جارٍ…" : "مزامنة الآن"}</button>
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="font-bold text-ink-900 font-arabic">طلبات العملاء المقبولة</h2>
        {state.orders.length === 0 && <p className="text-sm text-ink-500 font-arabic" data-testid="market-no-orders">لا طلبات تنتظر الخصم من المخزون.</p>}
        {state.orders.map((o) => {
          const complete = o.items.every((i) => i.linked_menu_item_id);
          return (
            <div key={o.order_id} className="rounded-md border border-ink-200 bg-white p-4 space-y-2 font-arabic" data-testid="market-order">
              <div className="flex items-center justify-between gap-2">
                <div><b>{o.buyer_name ?? "عميل"}</b> <span className="text-xs text-ink-500">{STATUS[o.status ?? ""] ?? o.status} · {formatMoney(o.total_cents)}</span></div>
                <button className={btnPrimary} disabled={busy === o.order_id} onClick={() => void apply(o.order_id)} data-testid="market-apply">اخصم من المخزون</button>
              </div>
              <ul className="text-sm space-y-0.5">
                {o.items.map((i) => (
                  <li key={i.order_item_id}>
                    <b>{i.qty} ×</b> {i.product_name}{" "}
                    {i.linked_name ? <span className="text-ink-500">← {i.linked_name}</span> : <span className="text-danger">(غير مربوط: لن يُخصم)</span>}
                  </li>
                ))}
              </ul>
              {!complete && <p className="text-xs text-danger">اربط المنتجات الناقصة أدناه ليُخصم الطلب تلقائياً.</p>}
            </div>
          );
        })}
      </section>

      <section className="space-y-2">
        <h2 className="font-bold text-ink-900 font-arabic">منتجاتك في السوق</h2>
        <div className="rounded-md border border-ink-200 bg-white overflow-x-auto">
          <table className="w-full text-sm font-arabic">
            <thead className="bg-surface-alt text-ink-500"><tr><th className="p-3 text-start">منتج السوق</th><th className="p-3 text-start">مخزونه في السوق</th><th className="p-3 text-start">منتجك على الرف</th></tr></thead>
            <tbody>
              {state.products.map((p) => (
                <tr key={p.supplier_product_id} className="border-t border-ink-100" data-testid="market-product">
                  <td className="p-3">{p.name}{p.unit ? <span className="text-xs text-ink-400"> · {p.unit}</span> : null}</td>
                  <td className="p-3 tabular">{p.stock_qty}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={p.linked_menu_item_id ?? ""}
                        disabled={busy === p.supplier_product_id}
                        onChange={(e) => void link(p.supplier_product_id, e.target.value || null)}
                        className="h-10 min-w-[200px] px-3 rounded-sm border-2 border-ink-200 bg-white text-sm outline-none focus:border-saffron-600"
                        data-testid={`market-link-${p.supplier_product_id}`}
                      >
                        <option value="">غير مربوط</option>
                        {mine.map((m) => <option key={m.menu_item_id} value={m.menu_item_id}>{m.name}</option>)}
                      </select>
                      {!p.linked_menu_item_id && p.suggested_menu_item_id && (
                        <button className="text-xs text-saffron-700 underline" onClick={() => void link(p.supplier_product_id, p.suggested_menu_item_id)}>اربط بـ «{p.suggested_name}»</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
