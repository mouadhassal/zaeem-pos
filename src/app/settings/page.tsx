import { useEffect, useState, useCallback } from "react";
import { getDb } from "../../db";
import { useAuthStore } from "../../stores/authStore";
import type { TaxMode } from "../../db/types";

type SettingsTab = "general" | "printer" | "tax" | "branch" | "subscription" | "cloud" | "backup" | "about";

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
  { id: "subscription", label: "الاشتراك" },
  { id: "cloud", label: "المزامنة السحابية" },
  { id: "backup", label: "النسخ الاحتياطي" },
  { id: "about", label: "عن النظام" },
];

const FEATURES = [
  { name: "عدد المستخدمين", starter: "3", pro: "10", enterprise: "غير محدود" },
  { name: "الفروع", starter: "1", pro: "5", enterprise: "غير محدود" },
  { name: "التقارير", starter: "أساسية", pro: "متقدمة", enterprise: "مخصصة" },
  { name: "المخزون", starter: "يدوي", pro: "آلي", enterprise: "آلي + ذكي" },
  { name: "الدعم", starter: "البريد", pro: "هاتف", enterprise: "مخصص 24/7" },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("general");
  const user = useAuthStore((s) => s.user);
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

  const showMsg = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 3000);
  };

  const fetchData = useCallback(async () => {
    try {
      const db = await getDb();

      const cfg = await db
        .selectFrom("chain_config")
        .selectAll()
        .where("id", "=", "default")
        .executeTakeFirst();
      if (cfg) {
        setConfig(cfg);
        setCurrency(cfg.currency);
        setTaxMode(cfg.tax_mode);
        setTaxRate(String(cfg.tax_rate_cents / 100));
      }

      const printerRows = await db
        .selectFrom("printers")
        .selectAll()
        .orderBy("name", "asc")
        .execute();
      setPrinters(printerRows);

      const branchRow = await db
        .selectFrom("branches")
        .selectAll()
        .limit(1)
        .executeTakeFirst();
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
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const saveCurrency = async () => {
    setSaving(true);
    try {
      const db = await getDb();
      await db
        .updateTable("chain_config")
        .set({ currency, sync_version: 1, last_modified: new Date().toISOString(), sync_status: "pending" })
        .where("id", "=", "default")
        .execute();
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
      const db = await getDb();
      await db
        .updateTable("chain_config")
        .set({
          tax_rate_cents: Math.round(parseFloat(taxRate || "0") * 100),
          tax_mode: taxMode,
          sync_version: 1,
          last_modified: new Date().toISOString(),
          sync_status: "pending",
        })
        .where("id", "=", "default")
        .execute();
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
      const db = await getDb();
      if (branch) {
        await db
          .updateTable("branches")
          .set({
            name: branchName,
            address: branchAddress || null,
            phone: branchPhone || null,
            max_tables: parseInt(branchMaxTables, 10) || 20,
            sync_version: 1,
            last_modified: new Date().toISOString(),
            sync_status: "pending",
          })
          .where("id", "=", branch.id)
          .execute();
      } else {
        await db
          .insertInto("branches")
          .values({
            id: crypto.randomUUID(),
            name: branchName,
            address: branchAddress || null,
            phone: branchPhone || null,
            max_tables: parseInt(branchMaxTables, 10) || 20,
            timezone: "Asia/Riyadh",
            currency: currency,
            tax_rate_cents: 1500,
            is_active: 1,
            sync_version: 1,
            last_modified: new Date().toISOString(),
            sync_status: "pending",
          })
          .execute();
      }
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
      const db = await getDb();
      await db
        .updateTable("printers")
        .set({
          is_active: printer.is_active ? 0 : 1,
          sync_version: 1,
          last_modified: new Date().toISOString(),
          sync_status: "pending",
        })
        .where("id", "=", printer.id)
        .execute();
      fetchData();
    } catch {
      showMsg("حدث خطأ في تحديث حالة الطابعة");
    }
  };

  const updatePaperWidth = async (printer: Printer, width: number) => {
    try {
      const db = await getDb();
      await db
        .updateTable("printers")
        .set({
          paper_width_mm: width,
          sync_version: 1,
          last_modified: new Date().toISOString(),
          sync_status: "pending",
        })
        .where("id", "=", printer.id)
        .execute();
      fetchData();
    } catch {
      showMsg("حدث خطأ في تحديث عرض الورق");
    }
  };

  return (
    <div className="flex h-full overflow-hidden" dir="rtl">
      <nav className="w-44 bg-white border-l border-slate-200 flex flex-col py-3 gap-0.5 shrink-0 overflow-y-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`text-right px-4 py-3 font-arabic text-sm transition-colors ${
              tab === t.id
                ? "bg-emerald-50 text-emerald-600 font-bold border-r-2 border-emerald-600"
                : "text-slate-500 hover:bg-white hover:text-slate-900"
            } ${t.id === "subscription" && !isOwner ? "opacity-50 cursor-not-allowed" : ""}`}
            disabled={t.id === "subscription" && !isOwner}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {tab === "general" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-slate-900 font-arabic">الإعدادات العامة</h2>
            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">اللغة</label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                >
                  <option value="ar">العربية</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">العملة</label>
                <div className="flex gap-3">
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="flex-1 h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={saveCurrency}
                    disabled={saving}
                    className="h-10 px-6 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors disabled:opacity-50"
                  >
                    حفظ
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">المنطقة الزمنية</label>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 text-sm outline-none focus:border-emerald-500"
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
            <h2 className="text-lg font-bold text-slate-900 font-arabic">إعدادات الطابعة</h2>
            {printers.length === 0 && (
              <div className="bg-white rounded-2xl p-8 shadow-sm text-center text-slate-500 font-arabic">
                لا توجد طابعات مسجلة
              </div>
            )}
            {printers.map((printer) => (
              <div key={printer.id} className="bg-white rounded-2xl p-5 shadow-sm space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-arabic font-bold text-slate-900">{printer.name}</h3>
                  <button
                    onClick={() => togglePrinterActive(printer)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      printer.is_active ? "bg-emerald-600" : "bg-slate-300"
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
                  <span className="text-sm text-slate-400 font-arabic">عرض الورق:</span>
                  <div className="flex gap-2">
                    {PAPER_WIDTHS.map((w) => (
                      <button
                        key={w}
                        onClick={() => updatePaperWidth(printer, w)}
                        className={`px-3 py-1 rounded-lg text-xs font-mono transition-colors ${
                          printer.paper_width_mm === w
                            ? "bg-emerald-600 text-white"
                            : "bg-white text-slate-500 hover:bg-slate-200"
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
                  className="px-4 py-2 rounded-xl bg-white text-slate-500 text-sm font-arabic hover:bg-slate-200 transition-colors"
                >
                  اختبار الطباعة
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === "tax" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-slate-900 font-arabic">إعدادات الضرائب</h2>
            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">نسبة الضريبة (%)</label>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min="0"
                    max="30"
                    step="0.5"
                    value={taxRate}
                    onChange={(e) => setTaxRate(e.target.value)}
                    className="flex-1 accent-emerald-600"
                  />
                  <input
                    type="number"
                    min="0"
                    max="30"
                    step="0.5"
                    value={taxRate}
                    onChange={(e) => setTaxRate(e.target.value)}
                    className="w-20 h-10 px-3 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm text-center outline-none focus:border-emerald-500"
                    dir="ltr"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">نظام الضريبة</label>
                <div className="flex gap-3">
                  <button
                    onClick={() => setTaxMode("exclusive")}
                    className={`flex-1 h-10 rounded-xl font-arabic text-sm transition-colors ${
                      taxMode === "exclusive"
                        ? "bg-emerald-600 text-white shadow-sm"
                        : "bg-white text-slate-500 hover:bg-slate-200"
                    }`}
                  >
                    غير شامل
                  </button>
                  <button
                    onClick={() => setTaxMode("inclusive")}
                    className={`flex-1 h-10 rounded-xl font-arabic text-sm transition-colors ${
                      taxMode === "inclusive"
                        ? "bg-emerald-600 text-white shadow-sm"
                        : "bg-white text-slate-500 hover:bg-slate-200"
                    }`}
                  >
                    شامل
                  </button>
                </div>
              </div>
              <button
                onClick={saveTax}
                disabled={saving}
                className="h-10 px-6 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                حفظ إعدادات الضريبة
              </button>
            </div>
          </div>
        )}

        {tab === "branch" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-slate-900 font-arabic">بيانات الفرع</h2>
            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">اسم الفرع</label>
                <input
                  type="text"
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">العنوان</label>
                <input
                  type="text"
                  value={branchAddress}
                  onChange={(e) => setBranchAddress(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-arabic text-sm outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">رقم الهاتف</label>
                <input
                  type="text"
                  value={branchPhone}
                  onChange={(e) => setBranchPhone(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                  dir="ltr"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">الحد الأقصى للطاولات</label>
                <input
                  type="number"
                  min="1"
                  value={branchMaxTables}
                  onChange={(e) => setBranchMaxTables(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 font-mono text-sm outline-none focus:border-emerald-500"
                  dir="ltr"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-slate-900 mb-1">ساعات العمل</label>
                <div className="flex gap-3 items-center">
                  <input
                    type="time"
                    value={branchOpenTime}
                    onChange={(e) => setBranchOpenTime(e.target.value)}
                    className="flex-1 h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 text-sm outline-none focus:border-emerald-500"
                  />
                  <span className="text-slate-500 font-arabic">إلى</span>
                  <input
                    type="time"
                    value={branchCloseTime}
                    onChange={(e) => setBranchCloseTime(e.target.value)}
                    className="flex-1 h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-900 text-sm outline-none focus:border-emerald-500"
                  />
                </div>
              </div>
              <button
                onClick={saveBranch}
                disabled={saving}
                className="h-10 px-6 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                حفظ بيانات الفرع
              </button>
            </div>
          </div>
        )}

        {tab === "subscription" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-slate-900 font-arabic">الاشتراك</h2>
            {!isOwner && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-amber-700 font-arabic text-sm">
                هذه الصفحة متاحة للمالك فقط
              </div>
            )}
            <div className="grid grid-cols-3 gap-4">
              {(["STARTER", "PRO", "ENTERPRISE"] as const).map((plan) => (
                <div
                  key={plan}
                  className={`bg-white rounded-2xl p-5 shadow-sm space-y-3 ${
                    plan === "PRO" ? "ring-2 ring-emerald-400" : ""
                  }`}
                >
                  <div className="text-center">
                    <h3 className="font-bold text-slate-900 font-arabic text-lg">
                      {plan === "STARTER" ? "ستارتر" : plan === "PRO" ? "برو" : "إنتربرايز"}
                    </h3>
                    {plan === "PRO" && (
                      <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-arabic font-medium bg-emerald-100 text-emerald-700">
                        الاشتراك الحالي
                      </span>
                    )}
                  </div>
                  <div className="text-2xl font-bold text-center text-emerald-600 font-mono">
                    {plan === "STARTER" ? "مجاني" : plan === "PRO" ? "99 $" : "199 $"}
                  </div>
                  <ul className="space-y-2 text-sm">
                    {FEATURES.map((f) => (
                      <li key={f.name} className="flex justify-between text-slate-500">
                        <span className="font-arabic">{f.name}</span>
                        <span className="font-mono text-slate-900 font-medium">
                          {f[plan.toLowerCase() as keyof typeof f]}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {isOwner && (
              <div className="bg-white rounded-2xl p-5 shadow-sm flex items-center justify-between">
                <div>
                  <p className="font-arabic text-slate-900">تاريخ انتهاء الاشتراك</p>
                  <p className="font-mono text-slate-900 font-bold">2027-12-31</p>
                </div>
                <button className="h-10 px-6 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors">
                  تجديد الاشتراك
                </button>
              </div>
            )}
          </div>
        )}

        {tab === "cloud" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-slate-900 font-arabic">المزامنة السحابية</h2>
            <div className="bg-white rounded-2xl p-8 shadow-sm flex flex-col items-center justify-center text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center">
                <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
              </div>
              <h3 className="text-lg font-bold text-slate-900 font-arabic">قريباً</h3>
              <p className="text-slate-500 font-arabic text-sm max-w-md">
                المزامنة السحابية ستتيح لك مزامنة البيانات بين عدة فروع وأجهزة بشكل آلي وآمن.
              </p>
              <div className="bg-slate-50 rounded-xl p-4 w-full text-right space-y-2">
                <p className="text-sm font-arabic text-slate-700 font-bold">الميزات القادمة:</p>
                <ul className="text-sm text-slate-500 space-y-1 font-arabic list-disc pr-4">
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
            <h2 className="text-lg font-bold text-slate-900 font-arabic">النسخ الاحتياطي</h2>
            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-400 font-arabic">آخر نسخة احتياطية</span>
                <span className="text-sm font-mono text-slate-900">
                  {lastBackup
                    ? new Date(lastBackup).toLocaleString("ar-SA")
                    : "لم يتم إنشاء نسخة بعد"}
                </span>
              </div>
              <button
                onClick={handleBackup}
                disabled={backingUp}
                className="w-full h-12 rounded-xl bg-emerald-600 text-white font-bold text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {backingUp ? "جاري..." : "نسخ احتياطي الآن"}
              </button>
              <div className="flex items-center justify-between pt-2 border-t border-slate-200">
                <span className="text-sm font-arabic text-slate-900">النسخ الاحتياطي التلقائي</span>
                <button
                  onClick={() => setAutoBackup(!autoBackup)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    autoBackup ? "bg-emerald-600" : "bg-slate-300"
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
            <h2 className="text-lg font-bold text-slate-900 font-arabic">عن النظام</h2>
            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-400 font-arabic">الإصدار</span>
                <span className="font-mono font-bold text-slate-900">1.0.0</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-400 font-arabic">آخر تحديث</span>
                <span className="font-mono text-slate-900">2026-07-01</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-400 font-arabic">نظام التشغيل</span>
                <span className="font-mono text-slate-900">Windows / Linux / macOS</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-400 font-arabic">قاعدة البيانات</span>
                <span className="font-mono text-slate-900">SQLite</span>
              </div>
              <div className="border-t border-slate-200 pt-4">
                <p className="text-sm font-arabic text-slate-900 mb-2">الدعم الفني</p>
                <a
                  href="mailto:support@zaeem.com"
                  className="text-emerald-600 hover:underline font-arabic text-sm"
                  dir="ltr"
                >
                  support@zaeem.com
                </a>
              </div>
            </div>
          </div>
        )}
      </div>

      {message && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-emerald-600 text-white px-6 py-3 rounded-xl shadow-lg z-50 font-arabic">
          {message}
        </div>
      )}
    </div>
  );
}
