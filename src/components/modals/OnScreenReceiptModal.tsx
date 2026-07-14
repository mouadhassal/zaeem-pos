import { generateOnScreenReceiptHTML } from "../../lib/printer";
import type { ReceiptData } from "../../lib/printer";

interface Props {
  receiptData: ReceiptData | null;
  onClose: () => void;
}

export default function OnScreenReceiptModal({ receiptData, onClose }: Props) {
  if (!receiptData) return null;

  const html = generateOnScreenReceiptHTML(receiptData);

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-elevated w-[400px] max-h-[80vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-arabic font-bold text-lg text-slate-900">الفاتورة</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-white flex items-center justify-center"
          >
            <svg className="w-5 h-5 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div dangerouslySetInnerHTML={{ __html: html }} />

        <div className="px-6 py-4 border-t border-slate-200">
          <p className="font-arabic text-sm text-amber-600 text-center mb-3">
            سيتم الطباعة عند إعادة الاتصال بالطابعة
          </p>
          <button
            onClick={onClose}
            className="w-full h-12 rounded-xl bg-emerald-600 text-white font-arabic font-bold hover:bg-emerald-700"
          >
            تم
          </button>
        </div>
      </div>
    </div>
  );
}
