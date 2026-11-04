import { useState } from "react";
import ImportTab from "./ImportTab";
import LogTab from "./LogTab";
import ReceiveTab from "./ReceiveTab";
import SettingsTab from "./SettingsTab";
import StockTab from "./StockTab";

type Tab = "stock" | "receive" | "import" | "log" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "stock", label: "المخزون" },
  { id: "receive", label: "استلام بضاعة" },
  { id: "import", label: "استيراد من ملف" },
  { id: "log", label: "الحركات" },
  { id: "settings", label: "الباركود والإعدادات" },
];

/**
 * Shop stock: what is on the shelf per product. A product keeps its own stock when tracking is on; a sale
 * lowers it, a delivery raises it, a count sets it, and every movement is kept. Products come in from a
 * spreadsheet, goods are received by scanning their barcodes.
 */
export default function StockroomPage() {
  const [tab, setTab] = useState<Tab>("stock");
  const [refreshKey, setRefreshKey] = useState(0);
  const changed = () => setRefreshKey((k) => k + 1);

  return (
    <div className="p-6 space-y-5 overflow-y-auto h-full" dir="rtl" data-testid="stockroom-page">
      <div>
        <h1 className="text-xl font-bold text-ink-900 font-arabic">مخزون المنتجات</h1>
        <p className="text-sm text-ink-500 font-arabic">كم بقي من كل منتج على الرف. كل بيع يُنقص المخزون وكل استلام يزيده، وكل حركة محفوظة.</p>
      </div>
      <div className="flex flex-wrap gap-2 border-b border-ink-200 pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            data-testid={`stockroom-tab-${t.id}`}
            className={`px-5 py-2 rounded-t-lg font-arabic font-medium text-sm transition-colors ${tab === t.id ? "bg-saffron-600 text-white" : "text-ink-500 hover:text-saffron-600 hover:bg-white"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "stock" && <StockTab refreshKey={refreshKey} onChanged={changed} onGoImport={() => setTab("import")} />}
      {tab === "receive" && <ReceiveTab onDone={() => { changed(); setTab("stock"); }} />}
      {tab === "import" && <ImportTab onDone={() => { changed(); setTab("stock"); }} />}
      {tab === "log" && <LogTab refreshKey={refreshKey} />}
      {tab === "settings" && <SettingsTab />}
    </div>
  );
}
