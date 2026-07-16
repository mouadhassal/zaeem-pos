import { useState } from "react";
import { X, Copy, Check, Eye, EyeOff } from "lucide-react";

const credentials = [
  { role: "المدير", username: "owner", password: "admin123", access: "كل الصلاحيات", color: "text-amber-400", bg: "bg-amber-500/10" },
  { role: "المشرف", username: "manager", password: "admin123", access: "إدارة ما عدا الإعدادات", color: "text-blue-400", bg: "bg-blue-500/10" },
  { role: "الكاشير", username: "cashier", password: "admin123", access: "نقطة البيع والزبائن", color: "text-saffron-600", bg: "bg-saffron-600/10" },
  { role: "المطبخ", username: "kitchen", password: "admin123", access: "شاشة المطبخ فقط", color: "text-rose-400", bg: "bg-rose-500/10" },
];

export default function CredentialsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [showPasswords, setShowPasswords] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" dir="rtl">
      <div className="w-full max-w-lg bg-ink-50 border border-ink-200 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between p-6 border-b border-ink-200">
          <div>
            <h2 className="text-xl font-bold text-white">بيانات تسجيل الدخول</h2>
            <p className="text-sm text-ink-500 mt-1">احفظ هذه البيانات أو شاركها مع الموظفين</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white text-ink-500">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-3">
          <div className="flex items-center justify-between mb-4">
            <button
              onClick={() => setShowPasswords(!showPasswords)}
              className="flex items-center gap-2 text-sm text-saffron-600 hover:text-saffron-300"
            >
              {showPasswords ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              {showPasswords ? "إخفاء كلمات المرور" : "إظهار كلمات المرور"}
            </button>
          </div>

          {credentials.map((cred) => (
            <div key={cred.username} className="bg-ink-50 rounded-xl p-4 border border-ink-200/50">
              <div className="flex items-center justify-between mb-3">
                <div className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-lg text-xs font-bold ${cred.bg} ${cred.color}`}>
                  {cred.role}
                </div>
                <span className="text-xs text-ink-400">{cred.access}</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-ink-400">اسم المستخدم</label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-ink-50 rounded-lg px-3 py-2 text-sm text-saffron-600 font-mono">{cred.username}</code>
                    <button
                      onClick={() => copy(cred.username, cred.username)}
                      className="p-2 rounded-lg hover:bg-ink-100 text-ink-500 transition-colors"
                    >
                      {copied === cred.username ? <Check className="w-4 h-4 text-saffron-600" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-ink-400">كلمة المرور</label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-ink-50 rounded-lg px-3 py-2 text-sm text-rose-400 font-mono">
                      {showPasswords ? cred.password : "••••••••"}
                    </code>
                    <button
                      onClick={() => copy(cred.password, cred.password + cred.username)}
                      className="p-2 rounded-lg hover:bg-ink-100 text-ink-500 transition-colors"
                    >
                      {copied === cred.password + cred.username ? <Check className="w-4 h-4 text-saffron-600" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="p-6 border-t border-ink-200 bg-ink-50/50">
          <button onClick={onClose} className="w-full py-3 rounded-xl bg-saffron-600 hover:bg-saffron-600 text-white font-bold transition-colors">
            تم الفهم
          </button>
        </div>
      </div>
    </div>
  );
}
