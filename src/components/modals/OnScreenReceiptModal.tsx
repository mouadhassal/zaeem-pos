import { useEffect } from "react";
import { IconX } from "@tabler/icons-react";
import { generateOnScreenReceiptHTML } from "../../lib/printer";
import type { ReceiptData } from "../../lib/printer";

interface Props {
  receiptData: ReceiptData | null;
  onClose: () => void;
}

export default function OnScreenReceiptModal({ receiptData, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!receiptData) return null;

  const html = generateOnScreenReceiptHTML(receiptData);

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-surface rounded-2xl border border-ink-600 w-[400px] max-h-[80vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-ink-200 flex items-center justify-between">
          <h2 className="font-arabic font-bold text-lg text-ink-900">الفاتورة</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center transition-colors"
          >
            <IconX className="w-5 h-5 text-ink-500" stroke={1.75} />
          </button>
        </div>

        <div dangerouslySetInnerHTML={{ __html: html }} />

        <div className="px-6 py-4 border-t border-ink-200">
          <p className="font-arabic text-sm text-warn text-center mb-3">
            سيتم الطباعة عند إعادة الاتصال بالطابعة
          </p>
          <button
            onClick={onClose}
            className="w-full h-12 rounded-xl bg-accent text-white font-arabic font-bold hover:bg-accent-text"
          >
            تم
          </button>
        </div>
      </div>
    </div>
  );
}
