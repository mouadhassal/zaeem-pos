import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "../../stores/authStore";
import type { TaxMode } from "../../db/types";
import { checkLicense, activateLicense, backOfficeLocked, type LicenseStatus } from "../../lib/license";

type SettingsTab = "general" | "printer" | "tax" | "branch" | "license" | "cloud" | "backup" | "about";

interface ChainConfig {
  currency: string;
  tax_mode: TaxMode;
  tax_rate_cents: number;
  chain_name: string;
}

interface Printer {
  id: string;
  name: string;
  paper_width_mm: number;
  is_active: number;
}

interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  max_tables: number;
}

const CURRENCIES = [
  { value: "SYP", label: "ليرة سورية (SYP)" },
  { value: "SAR", label: "ريال سعودي (SAR)" },
  { value: "IQD", label: "دينار عراقي (IQD)" },
  { value: "JOD", label: "دينار أردني (JOD)" },
  { value: "USD", label: "دولار أمريكي (USD)" },
];

const PAPER_WIDTHS = [58, 80];

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "عام" },
  { id: "printer", label: "الطابعة" },
  { id: "tax", label: "الضرائب" },
  { id: "branch", label: "الفرع" },
  { id: "license", label: "الترخيص" },
  { id: "cloud", label: "المزامنة السحابية" },
  { id: "backup", label: "النسخ الاحتياطي" },
  { id: "about", label: "عن النظام" },
];

/**
 * Maps the backend's activation failure strings to distinct Arabic
 * messages. The backend returns exact, stable strings -- either from
 * license/cloud.rs's decode_activation_key (malformed key) or from
 * license_core::signed::LicenseError's Display impl (accept_renewal
 * failures) -- matched here by substring so this stays correct even if the
 * exact English wording is tweaked later.
 */
function mapActivationError(raw: string): string {
  if (raw.includes("not valid base64")) {
    return "المفتاح غير صالح — تأكد من نسخه بالكامل والمحاولة مرة أخرى.";
  }
  if (raw.includes("corrupted or not in the expected format")) {
    return "تعذر قراءة المفتاح — تأكد من نسخه بالكامل دون أي تعديل.";
  }
  if (raw.includes("not valid base64/64 bytes")) {
    return "توقيع الترخيص غير صالح.";
  }
  if (raw.includes("does not verify against the embedded public key")) {
    return "توقيع الترخيص غير صحيح — قد يكون المفتاح تالفاً أو مزوراً.";
  }
  if (raw.includes("payload is not valid JSON")) {
    return "بيانات الترخيص تالفة.";
  }
  if (raw.includes("was not issued for this machine")) {
    return "هذا الترخيص صادر لجهاز آخر ولا يمكن استخدامه على هذا الجهاز.";
  }
  if (raw.includes("older than the currently installed license")) {
    return "هذا المفتاح أقدم من الترخيص المثبت حالياً على هذا الجهاز.";
  }
  return `حدث خطأ أثناء التفعيل: ${raw}`;
}

function formatExpiry(expiresAtMs: number): string {
  return new Date(expiresAtMs).toLocaleDateString("ar", { year: "numeric", month: "long", day: "numeric" });
}

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("general");
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const isOwner = user?.role === "OWNER";

  const [, setConfig] = useState<ChainConfig | null>(null);
  const [currency, setCurrency] = useState("SAR");
  const [language, setLanguage] = useState("ar");
  const [timezone, setTimezone] = useState("Asia/Riyadh");

  const [printers, setPrinters] = useState<Printer[]>([]);

  const [taxRate, setTaxRate] = useState("15");
  const [taxMode, setTaxMode] = useState<TaxMode>("exclusive");

  const [branch, setBranch] = useState<Branch | null>(null);
  const [branchName, setBranchName] = useState("");
  const [branchAddress, setBranchAddress] = useState("");
  const [branchPhone, setBranchPhone] = useState("");
  const [branchMaxTables, setBranchMaxTables] = useState("20");
  const [branchOpenTime, setBranchOpenTime] = useState("08:00");
  const [branchCloseTime, setBranchCloseTime] = useState("23:00");

  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [autoBackup, setAutoBackup] = useState(false);
  const [backingUp, setBackingUp] = useState(false);

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [activationKey, setActivationKey] = useState("");
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [activationSuccess, setActivationSuccess] = useState(false);

  // Every OTHER settings tab is back-office and locks with the rest of the
  // app; the license tab itself never does -- it's the only way out of a
  // locked state, so it can't be gated by the very thing it's meant to fix.
  const settingsLocked = licenseStatus !== null && backOfficeLocked(licenseStatus);

  const refreshLicense = useCallback(async () => {
    try {
      setLicenseStatus(await checkLicense());
    } catch {
      // checkLicense() itself never network-calls and shouldn't throw in
      // practice; leaving licenseStatus as-is (null shows a loading state,
      // a stale value stays visible) is safer than showing a fake error.
    }
  }, []);

  useEffect(() => {
    refreshLicense();
  }, [refreshLicense]);

  const handleActivate = async () => {
    if (!activationKey.trim() || !token) return;
    setActivating(true);
    setActivationError(null);
    setActivationSuccess(false);
    try {
      const status = await activateLicense(token, activationKey.trim());
      setLicenseStatus(status);
      setActivationSuccess(true);
      setActivationKey("");
    } catch (e) {
      setActivationError(mapActivationError(String(e)));
    } finally {
      setActivating(false);
    }
  };

  const showMsg = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 3000);
  };

  const fetchData = useCallback(async () => {
    try {
      const cfg = await invoke<{ chain_name: string; currency: string; tax_mode: TaxMode; tax_rate_cents: number }>("get_chain_config_v3", { sessionToken: token });
      setConfig(cfg);
      setCurrency(cfg.currency);
      setTaxMode(cfg.tax_mode);
      setTaxRate(String(cfg.tax_rate_cents / 100));

      const printerRows = await invoke<Printer[]>("list_printers_v3", { sessionToken: token });
      setPrinters(printerRows);

      const branchRow = await invoke<Branch | null>("get_legacy_branch_v3", { sessionToken: token });
      if (branchRow) {
        setBranch(branchRow);
        setBranchName(branchRow.name);
        setBranchAddress(branchRow.address ?? "");
        setBranchPhone(branchRow.phone ?? "");
        setBranchMaxTables(String(branchRow.max_tables));
      }
    } catch {
      showMsg("حدث خطأ في تحميل الإعدادات");
    }
  }, [token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const saveCurrency = async () => {
    setSaving(true);
    try {
      await invoke("update_chain_currency_v3", { sessionToken: token, currency });
      showMsg("تم حفظ العملة بنجاح");
      fetchData();
    } catch {
      showMsg("حدث خطأ في الحفظ");
    } finally {
      setSaving(false);
    }
  };

  const saveTax = async () => {
    setSaving(true);
    try {
      await invoke("update_chain_tax_v3", { sessionToken: token, taxRateCents: Math.round(parseFloat(taxRate || "0") * 100), taxMode });
      showMsg("تم حفظ إعدادات الضريبة بنجاح");
      fetchData();
    } catch {
      showMsg("حدث خطأ في الحفظ");
    } finally {
      setSaving(false);
    }
  };

  const saveBranch = async () => {
    setSaving(true);
    try {
      await invoke("save_legacy_branch_v3", {
        sessionToken: token,
        existingId: branch?.id ?? null,
        name: branchName,
        address: branchAddress || null,
        phone: branchPhone || null,
        maxTables: parseInt(branchMaxTables, 10) || 20,
        currency,
      });
      showMsg("تم حفظ بيانات الفرع بنجاح");
      fetchData();
    } catch {
      showMsg("حدث خطأ في الحفظ");
    } finally {
      setSaving(false);
    }
  };

  const handleBackup = async () => {
    setBackingUp(true);
    try {
      const { createBackup } = await import("../../lib/backup");
      await createBackup();
      setLastBackup(new Date().toISOString());
      showMsg("تم إنشاء النسخة الاحتياطية بنجاح");
    } catch {
      showMsg("حدث خطأ في إنشاء النسخة الاحتياطية");
    } finally {
      setBackingUp(false);
    }
  };

  const togglePrinterActive = async (printer: Printer) => {
    try {
      await invoke("set_printer_active_v3", { sessionToken: token, printerId: printer.id, isActive: !printer.is_active });
      fetchData();
    } catch {
      showMsg("حدث خطأ في تحديث حالة الطابعة");
    }
  };

  const updatePaperWidth = async (printer: Printer, width: number) => {
    try {
      await invoke("update_printer_paper_width_v3", { sessionToken: token, printerId: printer.id, paperWidthMm: width });
      fetchData();
    } catch {
      showMsg("حدث خطأ في تحديث عرض الورق");
    }
  };

  return (
    <div className="flex h-full overflow-hidden" dir="rtl">
      <nav className="w-44 bg-white border-l border-ink-200 flex flex-col py-3 gap-0.5 shrink-0 overflow-y-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`text-right px-4 py-3 font-arabic text-sm transition-colors ${
              tab === t.id
                ? "bg-saffron-50 text-saffron-600 font-bold border-r-2 border-saffron-600"
                : "text-ink-500 hover:bg-white hover:text-ink-900"
            } ${t.id === "license" && !isOwner ? "opacity-50 cursor-not-allowed" : ""}`}
            disabled={t.id === "license" && !isOwner}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {tab !== "license" && settingsLocked ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 px-6">
            <p className="text-base font-medium text-ink-900 font-arabic">هذه الشاشة مقفلة — الترخيص منتهي</p>
            <p className="text-sm text-ink-500 font-arabic max-w-sm">
              نقطة البيع تعمل بشكل طبيعي. اذهب إلى تبويب &quot;الترخيص&quot; على اليمين لتفعيل مفتاح جديد.
            </p>
          </div>
        ) : (
        <>
        {tab === "general" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">الإعدادات العامة</h2>
            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">اللغة</label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                >
                  <option value="ar">العربية</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">العملة</label>
                <div className="flex gap-3">
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="flex-1 h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={saveCurrency}
                    disabled={saving}
                    className="h-10 px-6 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
                  >
                    حفظ
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">المنطقة الزمنية</label>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
                >
                  <option value="Asia/Riyadh">الرياض (UTC+3)</option>
                  <option value="Asia/Baghdad">بغداد (UTC+3)</option>
                  <option value="Asia/Amman">عمّان (UTC+3)</option>
                  <option value="Asia/Dubai">دبي (UTC+4)</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {tab === "printer" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">إعدادات الطابعة</h2>
            {printers.length === 0 && (
              <div className="bg-white rounded-2xl p-8 shadow-sm text-center text-ink-500 font-arabic">
                لا توجد طابعات مسجلة
              </div>
            )}
            {printers.map((printer) => (
              <div key={printer.id} className="bg-white rounded-2xl p-5 shadow-sm space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-arabic font-bold text-ink-900">{printer.name}</h3>
                  <button
                    onClick={() => togglePrinterActive(printer)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      printer.is_active ? "bg-saffron-600" : "bg-ink-300"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        printer.is_active ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-ink-400 font-arabic">عرض الورق:</span>
                  <div className="flex gap-2">
                    {PAPER_WIDTHS.map((w) => (
                      <button
                        key={w}
                        onClick={() => updatePaperWidth(printer, w)}
                        className={`px-3 py-1 rounded-lg text-xs font-mono transition-colors ${
                          printer.paper_width_mm === w
                            ? "bg-saffron-600 text-white"
                            : "bg-white text-ink-500 hover:bg-ink-200"
                        }`}
                      >
                        {w}mm
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  onClick={async () => {
                    try {
                      const { testPrint } = await import("../../lib/printer");
                      await testPrint();
                      showMsg("تم إرسال أمر الطباعة التجريبي");
                    } catch {
                      showMsg("فشلت الطباعة التجريبية");
                    }
                  }}
                  className="px-4 py-2 rounded-xl bg-white text-ink-500 text-sm font-arabic hover:bg-ink-200 transition-colors"
                >
                  اختبار الطباعة
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === "tax" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">إعدادات الضرائب</h2>
            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">نسبة الضريبة (%)</label>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min="0"
                    max="30"
                    step="0.5"
                    value={taxRate}
                    onChange={(e) => setTaxRate(e.target.value)}
                    className="flex-1 accent-saffron-600"
                  />
                  <input
                    type="number"
                    min="0"
                    max="30"
                    step="0.5"
                    value={taxRate}
                    onChange={(e) => setTaxRate(e.target.value)}
                    className="w-20 h-10 px-3 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm text-center outline-none focus:border-saffron-500"
                    dir="ltr"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">نظام الضريبة</label>
                <div className="flex gap-3">
                  <button
                    onClick={() => setTaxMode("exclusive")}
                    className={`flex-1 h-10 rounded-xl font-arabic text-sm transition-colors ${
                      taxMode === "exclusive"
                        ? "bg-saffron-600 text-white shadow-sm"
                        : "bg-white text-ink-500 hover:bg-ink-200"
                    }`}
                  >
                    غير شامل
                  </button>
                  <button
                    onClick={() => setTaxMode("inclusive")}
                    className={`flex-1 h-10 rounded-xl font-arabic text-sm transition-colors ${
                      taxMode === "inclusive"
                        ? "bg-saffron-600 text-white shadow-sm"
                        : "bg-white text-ink-500 hover:bg-ink-200"
                    }`}
                  >
                    شامل
                  </button>
                </div>
              </div>
              <button
                onClick={saveTax}
                disabled={saving}
                className="h-10 px-6 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
              >
                حفظ إعدادات الضريبة
              </button>
            </div>
          </div>
        )}

        {tab === "branch" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">بيانات الفرع</h2>
            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">اسم الفرع</label>
                <input
                  type="text"
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">العنوان</label>
                <input
                  type="text"
                  value={branchAddress}
                  onChange={(e) => setBranchAddress(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">رقم الهاتف</label>
                <input
                  type="text"
                  value={branchPhone}
                  onChange={(e) => setBranchPhone(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500"
                  dir="ltr"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">الحد الأقصى للطاولات</label>
                <input
                  type="number"
                  min="1"
                  value={branchMaxTables}
                  onChange={(e) => setBranchMaxTables(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500"
                  dir="ltr"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">ساعات العمل</label>
                <div className="flex gap-3 items-center">
                  <input
                    type="time"
                    value={branchOpenTime}
                    onChange={(e) => setBranchOpenTime(e.target.value)}
                    className="flex-1 h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
                  />
                  <span className="text-ink-500 font-arabic">إلى</span>
                  <input
                    type="time"
                    value={branchCloseTime}
                    onChange={(e) => setBranchCloseTime(e.target.value)}
                    className="flex-1 h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
                  />
                </div>
              </div>
              <button
                onClick={saveBranch}
                disabled={saving}
                className="h-10 px-6 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
              >
                حفظ بيانات الفرع
              </button>
            </div>
          </div>
        )}

        {tab === "license" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">الترخيص</h2>
            {!isOwner && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-amber-700 font-arabic text-sm">
                هذه الصفحة متاحة للمالك فقط
              </div>
            )}

            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-3">
              {!licenseStatus && (
                <p className="text-sm text-ink-400 font-arabic">جاري تحميل حالة الترخيص...</p>
              )}
              {licenseStatus?.kind === "Active" && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
                    <span className="font-arabic font-bold text-ink-900">نشط</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="font-arabic text-ink-400">الباقة</span>
                    <span className="font-mono text-ink-900">{licenseStatus.plan}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="font-arabic text-ink-400">تاريخ الانتهاء</span>
                    <span className="font-mono text-ink-900">{formatExpiry(licenseStatus.expires_at)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="font-arabic text-ink-400">الأيام المتبقية</span>
                    <span className="font-mono text-ink-900">{licenseStatus.days_remaining}</span>
                  </div>
                </>
              )}
              {licenseStatus?.kind === "Grace" && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                    <span className="font-arabic font-bold text-ink-900">فترة سماح</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="font-arabic text-ink-400">الباقة</span>
                    <span className="font-mono text-ink-900">{licenseStatus.plan}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="font-arabic text-ink-400">انتهى في</span>
                    <span className="font-mono text-ink-900">{formatExpiry(licenseStatus.expires_at)}</span>
                  </div>
                  <p className="text-sm font-arabic text-amber-700">
                    يرجى تجديد الترخيص خلال {licenseStatus.days_left_in_grace} أيام. نقطة البيع تعمل بشكل طبيعي.
                  </p>
                </>
              )}
              {licenseStatus?.kind === "LockedBackOffice" && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                    <span className="font-arabic font-bold text-ink-900">منتهي</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="font-arabic text-ink-400">الباقة السابقة</span>
                    <span className="font-mono text-ink-900">{licenseStatus.plan}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="font-arabic text-ink-400">انتهى في</span>
                    <span className="font-mono text-ink-900">{formatExpiry(licenseStatus.expires_at)}</span>
                  </div>
                  <p className="text-sm font-arabic text-red-700">
                    الإدارة والتقارير مقفلة. نقطة البيع تعمل بشكل طبيعي. فعّل مفتاحاً جديداً أدناه لإعادة الفتح.
                  </p>
                </>
              )}
              {licenseStatus?.kind === "Invalid" && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                    <span className="font-arabic font-bold text-ink-900">لا يوجد ترخيص صالح</span>
                  </div>
                  <p className="text-sm font-arabic text-red-700">
                    الإدارة والتقارير مقفلة. نقطة البيع تعمل بشكل طبيعي. فعّل مفتاحاً أدناه.
                  </p>
                </>
              )}
            </div>

            {isOwner && (
              <div className="bg-white rounded-2xl p-5 shadow-sm space-y-3">
                <label className="block text-sm font-arabic text-ink-900 mb-1">مفتاح التفعيل</label>
                <textarea
                  value={activationKey}
                  onChange={(e) => { setActivationKey(e.target.value); setActivationError(null); setActivationSuccess(false); }}
                  rows={4}
                  dir="ltr"
                  placeholder="الصق مفتاح التفعيل هنا"
                  className="w-full px-4 py-3 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-xs outline-none focus:border-saffron-500"
                />
                {activationError && (
                  <p className="text-sm font-arabic text-red-700">{activationError}</p>
                )}
                {activationSuccess && (
                  <p className="text-sm font-arabic text-green-700">تم تفعيل الترخيص بنجاح.</p>
                )}
                <button
                  onClick={handleActivate}
                  disabled={activating || !activationKey.trim()}
                  className="h-10 px-6 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
                >
                  {activating ? "جاري التفعيل..." : "تفعيل"}
                </button>
              </div>
            )}
          </div>
        )}

        {tab === "cloud" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">المزامنة السحابية</h2>
            <div className="bg-white rounded-2xl p-8 shadow-sm flex flex-col items-center justify-center text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-ink-100 flex items-center justify-center">
                <svg className="w-8 h-8 text-ink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
              </div>
              <h3 className="text-lg font-bold text-ink-900 font-arabic">قريباً</h3>
              <p className="text-ink-500 font-arabic text-sm max-w-md">
                المزامنة السحابية ستتيح لك مزامنة البيانات بين عدة فروع وأجهزة بشكل آلي وآمن.
              </p>
              <div className="bg-ink-50 rounded-xl p-4 w-full text-right space-y-2">
                <p className="text-sm font-arabic text-ink-700 font-bold">الميزات القادمة:</p>
                <ul className="text-sm text-ink-500 space-y-1 font-arabic list-disc pr-4">
                  <li>مزامنة فورية مع جميع الفروع</li>
                  <li>نسخ احتياطي تلقائي على السحابة</li>
                  <li>لوحة تحكم ويب للإدارة عن بعد</li>
                  <li>تطبيق جوال للمتابعة</li>
                  <li>تقارير موحدة لكل الفروع</li>
                  <li>تشغيل متعدد الأجهزة</li>
                </ul>
              </div>
              <span className="inline-block px-3 py-1 rounded-full bg-amber-100 text-amber-700 text-xs font-arabic font-medium">قيد التطوير</span>
            </div>
          </div>
        )}

        {tab === "backup" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">النسخ الاحتياطي</h2>
            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-400 font-arabic">آخر نسخة احتياطية</span>
                <span className="text-sm font-mono text-ink-900">
                  {lastBackup
                    ? new Date(lastBackup).toLocaleString("ar-SA")
                    : "لم يتم إنشاء نسخة بعد"}
                </span>
              </div>
              <button
                onClick={handleBackup}
                disabled={backingUp}
                className="w-full h-12 rounded-xl bg-saffron-600 text-white font-bold text-sm hover:bg-saffron-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {backingUp ? "جاري..." : "نسخ احتياطي الآن"}
              </button>
              <div className="flex items-center justify-between pt-2 border-t border-ink-200">
                <span className="text-sm font-arabic text-ink-900">النسخ الاحتياطي التلقائي</span>
                <button
                  onClick={() => setAutoBackup(!autoBackup)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    autoBackup ? "bg-saffron-600" : "bg-ink-300"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      autoBackup ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === "about" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">عن النظام</h2>
            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-400 font-arabic">الإصدار</span>
                <span className="font-mono font-bold text-ink-900">1.0.0</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-400 font-arabic">آخر تحديث</span>
                <span className="font-mono text-ink-900">2026-07-01</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-400 font-arabic">نظام التشغيل</span>
                <span className="font-mono text-ink-900">Windows / Linux / macOS</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-400 font-arabic">قاعدة البيانات</span>
                <span className="font-mono text-ink-900">SQLite</span>
              </div>
              <div className="border-t border-ink-200 pt-4">
                <p className="text-sm font-arabic text-ink-900 mb-2">الدعم الفني</p>
                <a
                  href="mailto:support@zaeem.com"
                  className="text-saffron-600 hover:underline font-arabic text-sm"
                  dir="ltr"
                >
                  support@zaeem.com
                </a>
              </div>
            </div>
          </div>
        )}
        </>
        )}
      </div>

      {message && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-saffron-600 text-white px-6 py-3 rounded-xl shadow-lg z-50 font-arabic">
          {message}
        </div>
      )}
    </div>
  );
}
