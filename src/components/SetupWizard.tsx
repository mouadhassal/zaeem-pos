import { useState } from "react";
import { useAuthStore } from "../stores/authStore";
import { invoke } from "@tauri-apps/api/core";
import { UtensilsCrossed, AlertCircle, Eye, EyeOff, ImagePlus } from "lucide-react";

const CURRENCIES = [
  { value: "SYP", label: "ليرة سورية (SYP)" },
  { value: "SAR", label: "ريال سعودي (SAR)" },
  { value: "IQD", label: "دينار عراقي (IQD)" },
  { value: "JOD", label: "دينار أردني (JOD)" },
  { value: "USD", label: "دولار أمريكي (USD)" },
];

export default function SetupWizard() {
  const [step, setStep] = useState<"account" | "branch">("account");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const setupOwner = useAuthStore((s) => s.setupOwner);

  const [branchName, setBranchName] = useState("");
  const [currency, setCurrency] = useState("SYP");
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);

  async function handleAccountSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 10) { setError("كلمة المرور يجب أن تكون 10 أحرف على الأقل"); return; }
    if (pin.length !== 6 || !/^\d{6}$/.test(pin)) { setError("الرقم السري يجب أن يكون 6 أرقام"); return; }
    setError("");
    setLoading(true);
    const err = await setupOwner(name, password, pin);
    if (err) { setError(err); setLoading(false); return; }
    setStep("branch");
    setLoading(false);
  }

  async function handleBranchSubmit() {
    if (!branchName.trim()) { setError("اسم الفرع مطلوب"); return; }
    setError("");
    setLoading(true);
    try {
      await invoke("update_chain_currency_v3", { sessionToken: useAuthStore.getState().token, currency });
      await invoke("save_legacy_branch_v3", {
        sessionToken: useAuthStore.getState().token,
        existingId: null,
        name: branchName.trim(),
        address: null,
        phone: null,
        maxTables: 20,
        currency,
      });
      if (logoDataUrl) {
        localStorage.setItem("zaeem_branch_logo", logoDataUrl);
      }
      localStorage.setItem("zaeem_setup_complete", "1");
      window.location.reload();
    } catch {
      setError("حدث خطأ في حفظ بيانات الفرع");
      setLoading(false);
    }
  }

  function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError("الصورة يجب أن تكون أقل من 2 ميغابايت"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      setLogoDataUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
  }

  if (step === "branch") {
    return (
      <div className="relative min-h-screen w-full overflow-hidden bg-ink-50" dir="rtl">
        <div className="min-h-screen flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-lg bg-saffron-600 mb-4">
                <UtensilsCrossed className="w-8 h-8 text-white" />
              </div>
              <h1 className="text-3xl font-bold text-ink-800 mb-2 tracking-tight">
                زعيم <span className="text-saffron-600">Zaeem</span>
              </h1>
              <p className="text-ink-400 text-sm">بيانات الفرع</p>
            </div>

            <div className="bg-white border border-ink-200 rounded-md p-8 shadow-sh-1">
              {error && (
                <div className="mb-6 flex items-center gap-2 p-3 rounded-sm bg-red-50 border border-red-200 text-red-600 text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-5">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-ink-700">اسم الفرع</label>
                  <input
                    type="text"
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    placeholder="مثال: فرع الشام"
                    className="w-full h-11 px-4 rounded-sm border border-ink-300 text-ink-800 placeholder:text-ink-400 text-right outline-none focus:border-saffron-500 focus:ring-1 focus:ring-saffron-500/20 transition-colors"
                    dir="rtl"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-ink-700">العملة</label>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="w-full h-11 px-4 rounded-sm border border-ink-300 text-ink-800 text-right outline-none focus:border-saffron-500 focus:ring-1 focus:ring-saffron-500/20 transition-colors font-arabic"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-ink-700">شعار الفرع (اختياري)</label>
                  <div className="flex items-center gap-4">
                    {logoDataUrl ? (
                      <div className="relative">
                        <img src={logoDataUrl} alt="شعار الفرع" className="w-16 h-16 rounded-lg object-cover border border-ink-200" />
                        <button
                          onClick={() => setLogoDataUrl(null)}
                          className="absolute -top-2 -left-2 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center"
                        >
                         ✕
                        </button>
                      </div>
                    ) : (
                      <label className="w-16 h-16 rounded-lg border-2 border-dashed border-ink-300 flex flex-col items-center justify-center cursor-pointer hover:border-saffron-500 transition-colors">
                        <ImagePlus className="w-5 h-5 text-ink-400" />
                        <span className="text-[10px] text-ink-400 mt-0.5">شعار</span>
                        <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                      </label>
                    )}
                    <p className="text-xs text-ink-400">يُعرض في الإيصالات والواجهة</p>
                  </div>
                </div>

                <button
                  onClick={handleBranchSubmit}
                  disabled={loading || !branchName.trim()}
                  className={`w-full h-11 rounded-sm font-bold text-white text-base transition-colors flex items-center justify-center gap-2 ${
                    loading || !branchName.trim()
                      ? "bg-ink-300 cursor-not-allowed text-ink-500"
                      : "bg-saffron-600 hover:bg-saffron-700 active:bg-saffron-800"
                  }`}
                >
                  {loading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>جاري الحفظ...</span>
                    </>
                  ) : (
                    <span>بدء الاستخدام</span>
                  )}
                </button>

                <button
                  onClick={() => { localStorage.setItem("zaeem_setup_complete", "1"); window.location.reload(); }}
                  className="w-full h-9 text-sm text-ink-400 hover:text-ink-600 transition-colors font-arabic"
                >
                  تخطي — الإعداد لاحقاً
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-ink-50" dir="rtl">
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-lg bg-saffron-600 mb-4">
              <UtensilsCrossed className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-ink-800 mb-2 tracking-tight">
              زعيم <span className="text-saffron-600">Zaeem</span>
            </h1>
            <p className="text-ink-400 text-sm">الإعداد الأولي — إنشاء حساب المالك</p>
          </div>

          <div className="bg-white border border-ink-200 rounded-md p-8 shadow-sh-1">
            {error && (
              <div className="mb-6 flex items-center gap-2 p-3 rounded-sm bg-red-50 border border-red-200 text-red-600 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleAccountSubmit} className="space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-medium text-ink-700">الاسم الكامل</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="أدخل اسم المالك"
                  className="w-full h-11 px-4 rounded-sm border border-ink-300 text-ink-800 placeholder:text-ink-400 text-right outline-none focus:border-saffron-500 focus:ring-1 focus:ring-saffron-500/20 transition-colors"
                  dir="rtl"
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-ink-700">كلمة المرور (10 أحرف على الأقل)</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••"
                    className="w-full h-11 px-4 pl-10 rounded-sm border border-ink-300 text-ink-800 placeholder:text-ink-400 text-right outline-none focus:border-saffron-500 focus:ring-1 focus:ring-saffron-500/20 transition-colors"
                    dir="rtl"
                    required
                    minLength={10}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 p-1 rounded-sm text-ink-400 hover:text-ink-600 transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-ink-700">الرقم السري لنقطة البيع (6 أرقام)</label>
                <div className="relative">
                  <input
                    type={showPin ? "text" : "password"}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="••••••"
                    className="w-full h-11 px-4 pl-10 rounded-sm border border-ink-300 text-ink-800 placeholder:text-ink-400 text-right outline-none focus:border-saffron-500 focus:ring-1 focus:ring-saffron-500/20 transition-colors"
                    dir="rtl"
                    required
                    maxLength={6}
                    inputMode="numeric"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin(!showPin)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 p-1 rounded-sm text-ink-400 hover:text-ink-600 transition-colors"
                  >
                    {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !name || password.length < 10 || pin.length !== 6}
                className={`w-full h-11 rounded-sm font-bold text-white text-base transition-colors flex items-center justify-center gap-2 ${
                  loading || !name || password.length < 10 || pin.length !== 6
                    ? "bg-ink-300 cursor-not-allowed text-ink-500"
                    : "bg-saffron-600 hover:bg-saffron-700 active:bg-saffron-800"
                }`}
              >
                {loading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>جاري الإعداد...</span>
                  </>
                ) : (
                  <span>التالي — بيانات الفرع</span>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
