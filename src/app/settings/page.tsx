import { useEffect, useState, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import type { TaxMode } from "../../db/types";
import { checkLicense, activateLicense, getDeviceId, backOfficeLocked, type LicenseStatus } from "../../lib/license";
import { IconPencil as Pencil, IconTrash as Trash, IconPhotoPlus as ImagePlus, IconX as X } from "@tabler/icons-react";
import NetworkTab from "./NetworkTab";
import { checkForUpdatesManually } from "../../lib/autoUpdate";
import { createBackup, listBackups, type BackupInfo } from "../../lib/backup";
import { realErrorText } from "../../lib/errors";
import { CURRENCY_SYMBOL, parseMoneyInput, setCurrency } from "../../lib/money";

type SettingsTab = "general" | "printer" | "tax" | "branch" | "license" | "network" | "backup" | "about";

interface ChainConfig {
  currency: string;
  tax_mode: TaxMode;
  tax_rate_cents: number;
  chain_name: string;
}

interface Printer {
  id: string;
  name: string;
  printer_type: "RECEIPT" | "KITCHEN" | "LABEL";
  interface: "USB" | "NETWORK" | "BLUETOOTH";
  paper_width_mm: number;
  is_active: number;
  ip_address: string | null;
  port: number;
  system_printer_name: string | null;
}

interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  max_tables: number;
}

const PAPER_WIDTHS = [58, 80];

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "عام" },
  { id: "printer", label: "الطابعة" },
  { id: "tax", label: "الضرائب" },
  { id: "branch", label: "الفرع" },
  { id: "license", label: "الترخيص" },
  { id: "network", label: "الشبكة المحلية" },
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
  // T2.0 per-terminal licensing (plan §2): when the backend could confirm
  // this branch already has other active seats, it sends back the full,
  // final Arabic message itself (built in activate_license_v3 after a
  // count_active_licenses cloud lookup) -- passed through unchanged rather
  // than re-matched, since it's not one of the fixed English strings below.
  if (raw.includes("تواصل مع المندوب")) {
    return raw;
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
  // 2026-08-03 "next phase" (see nextphase.md §2): both default true so an
  // existing restaurant's experience never changes unless they opt out.
  const [hasTables, setHasTables] = useState(true);
  const [hasKitchen, setHasKitchen] = useState(true);

  const [printers, setPrinters] = useState<Printer[]>([]);
  const [systemPrinters, setSystemPrinters] = useState<{ systemName: string; name: string; isDefault: boolean }[]>([]);
  const [showAddPrinter, setShowAddPrinter] = useState(false);
  const [newPrinterName, setNewPrinterName] = useState("");
  const [newPrinterType, setNewPrinterType] = useState<"RECEIPT" | "KITCHEN" | "LABEL">("RECEIPT");
  const [newPrinterInterface, setNewPrinterInterface] = useState<"USB" | "NETWORK">("USB");
  const [newPrinterSystemName, setNewPrinterSystemName] = useState("");
  const [newPrinterIp, setNewPrinterIp] = useState("");
  const [newPrinterPort, setNewPrinterPort] = useState("9100");
  const [addingPrinter, setAddingPrinter] = useState(false);

  const [taxRate, setTaxRate] = useState("15");
  const [taxMode, setTaxMode] = useState<TaxMode>("exclusive");
  // 2026-08-02: real, per-tenant manager-approval thresholds -- replaces
  // two hardcoded constants that were wrong by orders of magnitude for a
  // currency whose real menu prices run in the thousands. SYP has no minor
  // unit (see src/lib/money.ts), so these are plain whole-SYP amounts --
  // no ×100/÷100 conversion at the invoke boundary.
  const [voidThreshold, setVoidThreshold] = useState("200");
  const [shiftDiffThreshold, setShiftDiffThreshold] = useState("500");

  const [branch, setBranch] = useState<Branch | null>(null);
  const [branchName, setBranchName] = useState("");
  const [branchAddress, setBranchAddress] = useState("");
  const [branchPhone, setBranchPhone] = useState("");

  // Physical dining tables -- any count (0, 1, 20, ...), not the old
  // disconnected `max_tables` number that never actually created/removed a
  // row. See create_table_v3/rename_table_v3/delete_table_v3.
  const [tables, setTables] = useState<{ id: string; name: string; status: string; current_order_id: string | null }[]>([]);
  const [newTableName, setNewTableName] = useState("");
  const [tableError, setTableError] = useState<string | null>(null);
  const [tableBusy, setTableBusy] = useState(false);
  const [editingTableId, setEditingTableId] = useState<string | null>(null);
  const [editingTableName, setEditingTableName] = useState("");

  const [branchLogo, setBranchLogo] = useState<string | null>(() => localStorage.getItem("zaeem_branch_logo"));

  // The "auto backup" toggle is persisted to localStorage so it survives
  // an app restart; the actual backup list (lastBackup, size, path) comes
  // from the real backend (backup_database_v3/list_backups_v3) now, not a
  // fake localStorage snapshot -- see lib/backup.ts's doc comment.
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [autoBackup, setAutoBackup] = useState(() => localStorage.getItem("zaeem_auto_backup_enabled") === "1");
  const [backingUp, setBackingUp] = useState(false);
  const lastBackup = backups[0]?.created_at ?? null;

  const toggleAutoBackup = () => {
    const next = !autoBackup;
    setAutoBackup(next);
    localStorage.setItem("zaeem_auto_backup_enabled", next ? "1" : "0");
  };

  const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [activationKey, setActivationKey] = useState("");
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [activationSuccess, setActivationSuccess] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceIdCopied, setDeviceIdCopied] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [diagnosticsSending, setDiagnosticsSending] = useState(false);
  const [diagnosticsResult, setDiagnosticsResult] = useState<string | null>(null);

  useEffect(() => {
    getDeviceId().then(setDeviceId).catch(() => {});
    import("@tauri-apps/api/app").then((m) => m.getVersion()).then(setAppVersion).catch(() => {});
  }, []);

  const handleCheckForUpdates = async () => {
    setUpdateChecking(true);
    setUpdateResult(null);
    try {
      const result = await checkForUpdatesManually();
      if (result.kind === "up_to_date") {
        setUpdateResult("أنت تستخدم أحدث إصدار بالفعل.");
      } else if (result.kind === "installed") {
        setUpdateResult(`تم العثور على تحديث (v${result.version}) وسيتم إعادة تشغيل التطبيق الآن...`);
        // downloadAndInstall + relaunch already happened inside
        // checkForUpdatesManually -- if execution reaches here at all
        // (it may not, since relaunch() can tear the process down first),
        // the message above is what a slower relaunch would still show
        // briefly.
      } else {
        setUpdateResult(`فشل التحقق من التحديثات: ${result.message}`);
      }
    } finally {
      setUpdateChecking(false);
    }
  };

  // 2026-08-02: opt-in, on-demand only -- this is the one way any signal
  // about a real error ever leaves the machine at all (see obslog.rs's
  // module doc), so it's worth surfacing as a real, visible action rather
  // than something silent/automatic.
  const handleSendDiagnostics = async () => {
    if (!token) return;
    setDiagnosticsSending(true);
    setDiagnosticsResult(null);
    try {
      await invoke("send_diagnostics_report_v3", { sessionToken: token });
      setDiagnosticsResult("تم إرسال التقرير التشخيصي بنجاح");
    } catch (e) {
      setDiagnosticsResult(`فشل إرسال التقرير: ${e}`);
    } finally {
      setDiagnosticsSending(false);
    }
  };

  const copyDeviceId = async () => {
    if (!deviceId) return;
    await navigator.clipboard.writeText(deviceId);
    setDeviceIdCopied(true);
    setTimeout(() => setDeviceIdCopied(false), 2000);
  };

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
      setTaxMode(cfg.tax_mode);
      setTaxRate(String(cfg.tax_rate_cents / 100));
      setCurrency(cfg.currency);

      const thresholds = await invoke<{ void_threshold_cents: number; shift_diff_threshold_cents: number }>("get_manager_thresholds_v3", { sessionToken: token });
      setVoidThreshold(String(thresholds.void_threshold_cents));
      setShiftDiffThreshold(String(thresholds.shift_diff_threshold_cents));

      const mode = await invoke<{ has_tables: boolean; has_kitchen: boolean }>("get_business_mode_v3", { sessionToken: token });
      setHasTables(mode.has_tables);
      setHasKitchen(mode.has_kitchen);

      const printerRows = await invoke<Printer[]>("list_printers_v3", { sessionToken: token });
      setPrinters(printerRows);

      const branchRow = await invoke<Branch | null>("get_legacy_branch_v3", { sessionToken: token });
      if (branchRow) {
        setBranch(branchRow);
        setBranchName(branchRow.name);
        setBranchAddress(branchRow.address ?? "");
        setBranchPhone(branchRow.phone ?? "");
      }
    } catch (err) {
      showMsg(`حدث خطأ في تحميل الإعدادات: ${realErrorText(err)}`);
    }
  }, [token]);

  const fetchTables = useCallback(async () => {
    try {
      const rows = await invoke<{ id: string; name: string; status: string; current_order_id: string | null }[]>(
        "list_tables_v3", { sessionToken: token }
      );
      setTables(rows);
    } catch {
      showMsg("حدث خطأ في تحميل الطاولات");
    }
  }, [token]);

  useEffect(() => {
    fetchData();
    fetchTables();
  }, [fetchData, fetchTables]);

  const handleAddTable = async () => {
    if (!newTableName.trim()) return;
    setTableError(null);
    setTableBusy(true);
    try {
      // 2026-08-22 QA re-audit: `branch` here is get_legacy_branch_v3's row
      // -- the legacy single-branch `branches` table SetupWizard writes to.
      // create_table_v3 validates its branchId against the real, separate
      // `branch` (singular) table T1.1's expand migration seeds with its
      // OWN fresh id -- the two tables were never reconciled, so branch.id
      // never matches and every "add table" failed with a raw, untranslated
      // "that branch does not belong to your tenant" (resolve_branch_for_
      // actor's error, commands_v3.rs). Passing null instead lets
      // resolve_operating_branch do what it already does correctly for
      // create_table_v3 (fixed earlier this session for exactly this
      // "single branch, no explicit id" case) -- auto-resolve the real
      // branch instead of trusting an id from the wrong table.
      await invoke("create_table_v3", { sessionToken: token, name: newTableName.trim(), branchId: null });
      setNewTableName("");
      await fetchTables();
    } catch (err) {
      setTableError(typeof err === "string" ? err : "حدث خطأ في إضافة الطاولة");
    } finally {
      setTableBusy(false);
    }
  };

  const handleRenameTable = async (tableId: string) => {
    if (!editingTableName.trim()) return;
    setTableError(null);
    try {
      await invoke("rename_table_v3", { sessionToken: token, tableId, name: editingTableName.trim() });
      setEditingTableId(null);
      setEditingTableName("");
      await fetchTables();
    } catch (err) {
      setTableError(typeof err === "string" ? err : "حدث خطأ في إعادة تسمية الطاولة");
    }
  };

  const handleDeleteTable = async (tableId: string) => {
    setTableError(null);
    try {
      await invoke("delete_table_v3", { sessionToken: token, tableId });
      await fetchTables();
    } catch (err) {
      setTableError(typeof err === "string" ? err : "حدث خطأ في حذف الطاولة");
    }
  };

  // 2026-08-03 "next phase": each switch saves (and takes effect)
  // immediately on toggle -- no separate "save" button, matching how a
  // real on/off setting should feel, not a form field.
  const saveBusinessMode = async (nextHasTables: boolean, nextHasKitchen: boolean) => {
    setHasTables(nextHasTables);
    setHasKitchen(nextHasKitchen);
    try {
      await invoke("update_business_mode_v3", { sessionToken: token, hasTables: nextHasTables, hasKitchen: nextHasKitchen });
      showMsg("تم حفظ نوع النشاط بنجاح");
    } catch (err) {
      showMsg(`حدث خطأ في الحفظ: ${realErrorText(err)}`);
      // Revert the optimistic UI update -- the save didn't actually happen.
      await fetchData();
    }
  };

  const saveTax = async () => {
    setSaving(true);
    try {
      await invoke("update_chain_tax_v3", { sessionToken: token, taxRateCents: Math.round(parseFloat(taxRate || "0") * 100), taxMode });
      showMsg("تم حفظ إعدادات الضريبة بنجاح");
      fetchData();
    } catch (err) {
      showMsg(`حدث خطأ في الحفظ: ${realErrorText(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const saveThresholds = async () => {
    setSaving(true);
    try {
      await invoke("update_manager_thresholds_v3", {
        sessionToken: token,
        voidThresholdCents: parseMoneyInput(voidThreshold),
        shiftDiffThresholdCents: parseMoneyInput(shiftDiffThreshold),
      });
      showMsg("تم حفظ حدود موافقة المدير بنجاح");
      fetchData();
    } catch (err) {
      showMsg(`حدث خطأ في الحفظ: ${realErrorText(err)}`);
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
        // The real table count now lives in the `tables` list below (see
        // create_table_v3/delete_table_v3) -- this legacy capacity number
        // is kept unchanged, not user-edited here anymore.
        maxTables: branch?.max_tables ?? 20,
        currency: "SYP",
      });
      showMsg("تم حفظ بيانات الفرع بنجاح");
      fetchData();
    } catch (err) {
      showMsg(`حدث خطأ في الحفظ: ${realErrorText(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const refreshBackups = useCallback(async () => {
    if (!token) return;
    try {
      const list = await listBackups(token);
      setBackups(list);
    } catch (e) {
      console.error("Failed to list backups:", e);
    }
  }, [token]);

  useEffect(() => {
    if (tab === "backup") refreshBackups();
  }, [tab, refreshBackups]);

  const handleBackup = useCallback(async (silent = false) => {
    if (!token) return;
    setBackingUp(true);
    try {
      await createBackup(token);
      await refreshBackups();
      if (!silent) showMsg("تم إنشاء النسخة الاحتياطية بنجاح");
    } catch (e) {
      if (!silent) showMsg(`حدث خطأ في إنشاء النسخة الاحتياطية: ${e}`);
    } finally {
      setBackingUp(false);
    }
  }, [token, refreshBackups]);

  // Real scheduler: checked every 30 minutes while Settings is open, runs a
  // silent backup once 24h have actually elapsed since the last one. Only
  // fires while this page is mounted (no true background/OS-level
  // scheduling exists in this app), but that covers the common case of the
  // POS terminal staying logged into some screen all day.
  useEffect(() => {
    if (!autoBackup) return;
    const checkAndRun = () => {
      const dueSince = lastBackup ? Date.now() - new Date(lastBackup).getTime() : Infinity;
      if (dueSince >= AUTO_BACKUP_INTERVAL_MS) {
        handleBackup(true);
      }
    };
    checkAndRun();
    const interval = setInterval(checkAndRun, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [autoBackup, handleBackup, lastBackup, AUTO_BACKUP_INTERVAL_MS]);

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

  const loadSystemPrinters = async () => {
    try {
      const { listSystemPrinters } = await import("../../lib/printer");
      setSystemPrinters(await listSystemPrinters());
    } catch {
      showMsg("تعذر قراءة قائمة الطابعات المثبتة على هذا الجهاز");
    }
  };

  const bindSystemPrinter = async (printer: Printer, systemPrinterName: string) => {
    if (!systemPrinterName) return;
    try {
      await invoke("update_printer_system_name_v3", { sessionToken: token, printerId: printer.id, systemPrinterName });
      showMsg("تم ربط الطابعة بنجاح");
      fetchData();
    } catch {
      showMsg("حدث خطأ في ربط الطابعة");
    }
  };

  const handleAddPrinter = async () => {
    if (!newPrinterName.trim()) return;
    if (newPrinterInterface === "USB" && !newPrinterSystemName) {
      showMsg("اختر طابعة من قائمة الطابعات المثبتة على هذا الجهاز");
      return;
    }
    setAddingPrinter(true);
    try {
      await invoke<string>("create_printer_v3", {
        sessionToken: token,
        name: newPrinterName.trim(),
        printerType: newPrinterType,
        interface: newPrinterInterface,
        vendorId: null,
        productId: null,
        drawerPulseMs: 200,
        isPrimary: printers.length === 0,
        systemPrinterName: newPrinterInterface === "USB" ? newPrinterSystemName : null,
        ipAddress: newPrinterInterface === "NETWORK" ? newPrinterIp.trim() || null : null,
        port: newPrinterInterface === "NETWORK" ? (parseInt(newPrinterPort, 10) || 9100) : null,
      });
      setShowAddPrinter(false);
      setNewPrinterName("");
      setNewPrinterSystemName("");
      setNewPrinterIp("");
      showMsg("تمت إضافة الطابعة بنجاح");
      fetchData();
    } catch (err) {
      showMsg(typeof err === "string" ? err : "حدث خطأ في إضافة الطابعة");
    } finally {
      setAddingPrinter(false);
    }
  };

  return (
    <div className="flex h-full overflow-hidden bg-canvas" dir="rtl">
      <nav className="w-44 bg-surface-alt border-l border-ink-200 flex flex-col py-3 gap-0.5 shrink-0 overflow-y-auto">
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
            <div className="bg-white rounded-md p-5 border border-ink-200 space-y-4">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">العملة</label>
                <p className="h-10 flex items-center px-4 rounded-sm bg-ink-50 border-2 border-ink-200 text-ink-900 font-arabic text-sm">
                  الليرة السورية ({CURRENCY_SYMBOL})
                </p>
              </div>
            </div>

            <h2 className="text-lg font-bold text-ink-900 font-arabic">نوع النشاط</h2>
            <div className="bg-white rounded-md p-5 border border-ink-200 space-y-4">
              <p className="text-xs text-ink-400 font-arabic">
                يناسب هذا مطعم كامل الخدمة افتراضياً. عطّل ما لا ينطبق على نشاطك -- مقهى بدون طاولات، متجر بدون مطبخ، أو الاثنين معاً
              </p>
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-arabic text-ink-900 block">لدينا طاولات</span>
                  <span className="text-xs font-arabic text-ink-400">إدارة الطاولات، الدمج، والتقسيم</span>
                </div>
                <button
                  onClick={() => saveBusinessMode(!hasTables, hasKitchen)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${hasTables ? "bg-saffron-600" : "bg-ink-300"}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${hasTables ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-ink-200">
                <div>
                  <span className="text-sm font-arabic text-ink-900 block">لدينا مطبخ</span>
                  <span className="text-xs font-arabic text-ink-400">طباعة تذاكر المطبخ وشاشة عرض المطبخ (KDS)</span>
                </div>
                <button
                  onClick={() => saveBusinessMode(hasTables, !hasKitchen)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${hasKitchen ? "bg-saffron-600" : "bg-ink-300"}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${hasKitchen ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === "printer" && (
          <div className="space-y-6 max-w-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-ink-900 font-arabic">إعدادات الطابعة</h2>
              <button
                onClick={() => { setShowAddPrinter((v) => !v); if (!showAddPrinter) loadSystemPrinters(); }}
                className="h-9 px-4 rounded-sm bg-saffron-600 text-white text-xs font-bold hover:bg-saffron-700 transition-colors"
              >
                {showAddPrinter ? "إلغاء" : "+ إضافة طابعة"}
              </button>
            </div>

            {showAddPrinter && (
              <div className="bg-white rounded-md p-5 border border-ink-200 space-y-3">
                <input
                  type="text"
                  value={newPrinterName}
                  onChange={(e) => setNewPrinterName(e.target.value)}
                  placeholder="اسم الطابعة (مثال: طابعة الكاشير)"
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
                />
                <div className="flex gap-2">
                  {/* 2026-08-03 "next phase": a business with no kitchen
                      has no use for a kitchen printer type at all. */}
                  {(["RECEIPT", "KITCHEN", "LABEL"] as const).filter((t) => hasKitchen || t !== "KITCHEN").map((t) => (
                    <button key={t} onClick={() => setNewPrinterType(t)} className={`flex-1 h-9 rounded-sm text-xs font-arabic transition-colors ${newPrinterType === t ? "bg-saffron-600 text-white" : "bg-white border-2 border-ink-200 text-ink-500"}`}>
                      {t === "RECEIPT" ? "إيصال" : t === "KITCHEN" ? "مطبخ" : "ملصق"}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  {(["USB", "NETWORK"] as const).map((i) => (
                    <button key={i} onClick={() => setNewPrinterInterface(i)} className={`flex-1 h-9 rounded-sm text-xs font-arabic transition-colors ${newPrinterInterface === i ? "bg-saffron-600 text-white" : "bg-white border-2 border-ink-200 text-ink-500"}`}>
                      {i === "USB" ? "USB" : "شبكة (IP)"}
                    </button>
                  ))}
                </div>

                {newPrinterInterface === "USB" && (
                  <div>
                    <select
                      value={newPrinterSystemName}
                      onChange={(e) => setNewPrinterSystemName(e.target.value)}
                      className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
                    >
                      <option value="">-- اختر طابعة من الأجهزة المثبتة --</option>
                      {systemPrinters.map((sp) => (
                        <option key={sp.systemName} value={sp.systemName}>{sp.name}{sp.isDefault ? " (افتراضية)" : ""}</option>
                      ))}
                    </select>
                    {systemPrinters.length === 0 && (
                      <p className="text-xs text-amber-700 font-arabic mt-1">
                        لم يتم العثور على أي طابعة مثبتة على هذا الجهاز -- تأكد من توصيل الطابعة وتثبيت تعريفها في نظام التشغيل أولاً.
                      </p>
                    )}
                  </div>
                )}
                {newPrinterInterface === "NETWORK" && (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newPrinterIp}
                      onChange={(e) => setNewPrinterIp(e.target.value)}
                      placeholder="عنوان IP (مثال: 192.168.1.50)"
                      dir="ltr"
                      className="flex-1 h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                    />
                    <input
                      type="number"
                      value={newPrinterPort}
                      onChange={(e) => setNewPrinterPort(e.target.value)}
                      placeholder="Port"
                      dir="ltr"
                      className="w-24 h-10 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                    />
                  </div>
                )}

                <button
                  onClick={handleAddPrinter}
                  disabled={addingPrinter || !newPrinterName.trim()}
                  className="h-10 px-6 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
                >
                  {addingPrinter ? "جاري الإضافة..." : "إضافة"}
                </button>
              </div>
            )}

            {printers.length === 0 && !showAddPrinter && (
              <div className="bg-white rounded-md p-8 border border-ink-200 text-center text-ink-500 font-arabic">
                لا توجد طابعات مسجلة
              </div>
            )}
            {printers.map((printer) => (
              <div key={printer.id} className="bg-white rounded-md p-5 border border-ink-200 space-y-3">
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

                {printer.interface === "USB" && !printer.system_printer_name && (
                  <div className="bg-amber-50 border border-amber-200 rounded-sm p-3 space-y-2">
                    <p className="text-xs font-arabic text-amber-700">
                      هذه الطابعة غير مرتبطة بطابعة حقيقية على هذا الجهاز -- لن تطبع حتى يتم الاختيار.
                    </p>
                    <div className="flex gap-2">
                      <select
                        onFocus={() => { if (systemPrinters.length === 0) loadSystemPrinters(); }}
                        onChange={(e) => bindSystemPrinter(printer, e.target.value)}
                        defaultValue=""
                        className="flex-1 h-9 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-xs outline-none focus:border-saffron-600"
                      >
                        <option value="">-- اختر طابعة --</option>
                        {systemPrinters.map((sp) => (
                          <option key={sp.systemName} value={sp.systemName}>{sp.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <span className="text-sm text-ink-400 font-arabic">عرض الورق:</span>
                  <div className="flex gap-2">
                    {PAPER_WIDTHS.map((w) => (
                      <button
                        key={w}
                        onClick={() => updatePaperWidth(printer, w)}
                        className={`px-3 py-1 rounded-sm text-xs font-mono transition-colors ${
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
                    } catch (err) {
                      showMsg(err instanceof Error ? err.message : "فشلت الطباعة التجريبية");
                    }
                  }}
                  className="px-4 py-2 rounded-sm bg-white text-ink-500 text-sm font-arabic hover:bg-ink-200 transition-colors"
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
            <div className="bg-white rounded-md p-5 border border-ink-200 space-y-4">
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
                    className="w-20 h-10 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm text-center outline-none focus:border-saffron-600"
                    dir="ltr"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">نظام الضريبة</label>
                <div className="flex gap-3">
                  <button
                    onClick={() => setTaxMode("exclusive")}
                    className={`flex-1 h-10 rounded-sm font-arabic text-sm transition-colors ${
                      taxMode === "exclusive"
                        ? "bg-saffron-600 text-white"
                        : "bg-white text-ink-500 hover:bg-ink-200"
                    }`}
                  >
                    غير شامل
                  </button>
                  <button
                    onClick={() => setTaxMode("inclusive")}
                    className={`flex-1 h-10 rounded-sm font-arabic text-sm transition-colors ${
                      taxMode === "inclusive"
                        ? "bg-saffron-600 text-white"
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
                className="h-10 px-6 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
              >
                حفظ إعدادات الضريبة
              </button>
            </div>

            <h2 className="text-lg font-bold text-ink-900 font-arabic">حدود موافقة المدير</h2>
            <div className="bg-white rounded-md p-5 border border-ink-200 space-y-4">
              <p className="text-xs text-ink-400 font-arabic">
                عند إلغاء صنف أو إغلاق وردية بفارق نقدي أكبر من الحد المحدد، يُطلب رمز مدير للتأكيد
              </p>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">حد إلغاء الصنف ({CURRENCY_SYMBOL})</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={voidThreshold}
                  onChange={(e) => setVoidThreshold(e.target.value)}
                  className="w-40 h-10 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                  dir="ltr"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">حد فارق إغلاق الوردية ({CURRENCY_SYMBOL})</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={shiftDiffThreshold}
                  onChange={(e) => setShiftDiffThreshold(e.target.value)}
                  className="w-40 h-10 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                  dir="ltr"
                />
              </div>
              <button
                onClick={saveThresholds}
                disabled={saving}
                className="h-10 px-6 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
              >
                حفظ حدود الموافقة
              </button>
            </div>
          </div>
        )}

        {tab === "branch" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">بيانات الفرع</h2>
            <div className="bg-white rounded-md p-5 border border-ink-200 space-y-4">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">اسم الفرع</label>
                <input
                  type="text"
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">العنوان</label>
                <input
                  type="text"
                  value={branchAddress}
                  onChange={(e) => setBranchAddress(e.target.value)}
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">رقم الهاتف</label>
                <input
                  type="text"
                  value={branchPhone}
                  onChange={(e) => setBranchPhone(e.target.value)}
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-600"
                  dir="ltr"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">شعار الفرع</label>
                <div className="flex items-center gap-4">
                  {branchLogo ? (
                    <div className="relative">
                      <img src={branchLogo} alt="شعار الفرع" className="w-16 h-16 rounded-lg object-cover border border-ink-200" />
                      <button
                        onClick={() => { setBranchLogo(null); localStorage.removeItem("zaeem_branch_logo"); }}
                        className="absolute -top-2 -left-2 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center hover:bg-red-600"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <label className="w-16 h-16 rounded-lg border-2 border-dashed border-ink-300 flex flex-col items-center justify-center cursor-pointer hover:border-saffron-500 transition-colors">
                      <ImagePlus className="w-5 h-5 text-ink-400" />
                      <span className="text-[10px] text-ink-400 mt-0.5">شعار</span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file || file.size > 2 * 1024 * 1024) return;
                          const reader = new FileReader();
                          reader.onload = () => {
                            const dataUrl = reader.result as string;
                            setBranchLogo(dataUrl);
                            localStorage.setItem("zaeem_branch_logo", dataUrl);
                          };
                          reader.readAsDataURL(file);
                        }}
                        className="hidden"
                      />
                    </label>
                  )}
                  <p className="text-xs text-ink-400 font-arabic">يُعرض في الإيصالات والواجهة (أقل من 2 ميغابايت)</p>
                </div>
              </div>
              <button
                onClick={saveBranch}
                disabled={saving}
                className="h-10 px-6 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
              >
                حفظ بيانات الفرع
              </button>
            </div>

            <h2 className="text-lg font-bold text-ink-900 font-arabic">الطاولات</h2>
            <div className="bg-white rounded-md p-5 border border-ink-200 space-y-3">
              <p className="text-xs text-ink-400 font-arabic">
                أضف أو أعد تسمية أو احذف أي عدد من الطاولات -- لا يوجد حد أدنى أو أقصى (يمكن أن يكون صفر، واحدة، أو عشرين).
              </p>
              {tableError && <p className="text-xs text-red-500 font-arabic">{tableError}</p>}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newTableName}
                  onChange={(e) => setNewTableName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && newTableName.trim()) handleAddTable(); }}
                  placeholder="اسم الطاولة الجديدة (مثال: طاولة 5)"
                  className="flex-1 h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
                />
                <button
                  onClick={handleAddTable}
                  disabled={tableBusy || !newTableName.trim()}
                  className="h-10 px-5 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50 shrink-0"
                >
                  إضافة
                </button>
              </div>

              {tables.length === 0 ? (
                <div className="text-center text-ink-400 font-arabic text-sm py-6">
                  لا توجد طاولات بعد
                </div>
              ) : (
                <div className="space-y-1.5">
                  {tables.map((t) => (
                    <div key={t.id} className="flex items-center justify-between gap-2 p-2.5 rounded-sm border border-ink-100">
                      {editingTableId === t.id ? (
                        <input
                          type="text"
                          autoFocus
                          value={editingTableName}
                          onChange={(e) => setEditingTableName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleRenameTable(t.id); if (e.key === "Escape") setEditingTableId(null); }}
                          className="flex-1 h-8 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600"
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-arabic text-ink-900">{t.name}</span>
                          <span
                            className={`text-[11px] font-arabic px-2 py-0.5 rounded-full ${
                              t.status === "FREE" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {t.status === "FREE" ? "شاغرة" : t.status === "OCCUPIED" ? "مشغولة" : "مدمجة"}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center gap-1 shrink-0">
                        {editingTableId === t.id ? (
                          <>
                            <button onClick={() => handleRenameTable(t.id)} className="h-8 px-3 rounded-sm bg-saffron-600 text-white text-xs font-bold hover:bg-saffron-700 transition-colors">حفظ</button>
                            <button onClick={() => setEditingTableId(null)} className="h-8 px-3 rounded-sm text-ink-500 text-xs font-arabic hover:bg-ink-100 transition-colors">إلغاء</button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => { setEditingTableId(t.id); setEditingTableName(t.name); }}
                              className="h-8 w-8 rounded-sm flex items-center justify-center text-ink-500 hover:bg-ink-100 transition-colors"
                              title="إعادة تسمية"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => {
                                if (window.confirm("هل أنت متأكد من حذف هذه الطاولة؟")) {
                                  handleDeleteTable(t.id);
                                }
                              }}
                              disabled={t.status !== "FREE" || !!t.current_order_id}
                              title={t.status !== "FREE" || t.current_order_id ? "لا يمكن حذف طاولة مشغولة أو مدمجة" : "حذف"}
                              className="h-8 w-8 rounded-sm flex items-center justify-center text-ink-500 hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-30 disabled:pointer-events-none"
                            >
                              <Trash className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "license" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">الترخيص</h2>
            {!isOwner && (
              <div className="bg-amber-50 border border-amber-200 rounded-md p-4 text-amber-700 font-arabic text-sm">
                هذه الصفحة متاحة للمالك فقط
              </div>
            )}

            {isOwner && (
              <div className="bg-white rounded-md p-5 border border-ink-200 space-y-2">
                <p className="text-sm font-arabic text-ink-900 font-bold">معرّف الجهاز (Device ID)</p>
                <p className="text-xs font-arabic text-ink-500">
                  أرسل هذا المعرّف إلى المورّد لإصدار ترخيص خاص بهذا الجهاز فقط.
                </p>
                <textarea
                  readOnly
                  value={deviceId ?? "جاري القراءة..."}
                  rows={2}
                  dir="ltr"
                  className="w-full px-3 py-2 rounded-sm bg-ink-50 border-2 border-ink-200 text-ink-900 font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  onClick={copyDeviceId}
                  disabled={!deviceId}
                  className="h-9 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 text-xs font-bold hover:bg-ink-100 transition-colors disabled:opacity-50"
                >
                  {deviceIdCopied ? "تم النسخ!" : "نسخ المعرّف"}
                </button>
              </div>
            )}

            <div className="bg-white rounded-md p-5 border border-ink-200 space-y-3">
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
              <div className="bg-white rounded-md p-5 border border-ink-200 space-y-3">
                <label className="block text-sm font-arabic text-ink-900 mb-1">مفتاح التفعيل</label>
                <textarea
                  value={activationKey}
                  onChange={(e) => { setActivationKey(e.target.value); setActivationError(null); setActivationSuccess(false); }}
                  rows={4}
                  dir="ltr"
                  placeholder="الصق مفتاح التفعيل هنا"
                  className="w-full px-4 py-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-mono text-xs outline-none focus:border-saffron-600"
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
                  className="h-10 px-6 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
                >
                  {activating ? "جاري التفعيل..." : "تفعيل"}
                </button>
              </div>
            )}
          </div>
        )}

        {tab === "network" && <NetworkTab token={token} />}

        {tab === "backup" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">النسخ الاحتياطي</h2>
            <div className="bg-white rounded-md p-5 border border-ink-200 space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-400 font-arabic">آخر نسخة احتياطية</span>
                <span className="text-sm font-mono text-ink-900">
                  {lastBackup
                    ? new Date(lastBackup).toLocaleString("ar-SA")
                    : "لم يتم إنشاء نسخة بعد"}
                </span>
              </div>
              <button
                onClick={() => handleBackup()}
                disabled={backingUp}
                className="w-full h-12 rounded-sm bg-saffron-600 text-white font-bold text-sm hover:bg-saffron-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {backingUp ? "جاري..." : "نسخ احتياطي الآن"}
              </button>
              <div className="flex items-center justify-between pt-2 border-t border-ink-200">
                <div>
                  <span className="text-sm font-arabic text-ink-900 block">النسخ الاحتياطي التلقائي</span>
                  <span className="text-xs font-arabic text-ink-400">نسخة كل 24 ساعة، طالما هذه الصفحة مفتوحة</span>
                </div>
                <button
                  onClick={toggleAutoBackup}
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

            {backups.length > 0 && (
              <div className="bg-white rounded-md p-5 border border-ink-200 space-y-2">
                <h3 className="text-sm font-bold text-ink-900 font-arabic mb-2">النسخ المحفوظة</h3>
                {backups.map((b) => (
                  <div key={b.path} className="flex items-center justify-between text-xs border-b border-ink-100 last:border-0 pb-2 last:pb-0">
                    <span className="font-mono text-ink-500 truncate" dir="ltr" title={b.path}>{b.path}</span>
                    <span className="text-ink-400 shrink-0 mr-2">{(b.size_bytes / 1024).toFixed(0)} KB</span>
                  </div>
                ))}
                <p className="text-[10px] text-ink-300 font-arabic pt-1">يتم الاحتفاظ بآخر 20 نسخة فقط، ويتم حذف الأقدم تلقائياً</p>
              </div>
            )}
          </div>
        )}

        {tab === "about" && (
          <div className="space-y-6 max-w-xl">
            <h2 className="text-lg font-bold text-ink-900 font-arabic">عن النظام</h2>
            <div className="bg-white rounded-md p-5 border border-ink-200 space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-400 font-arabic">الإصدار</span>
                <span className="font-mono font-bold text-ink-900">{appVersion ?? "..."}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-400 font-arabic">نظام التشغيل</span>
                <span className="font-mono text-ink-900">Windows / Linux / macOS</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-400 font-arabic">قاعدة البيانات</span>
                <span className="font-mono text-ink-900">SQLite</span>
              </div>
              <div className="border-t border-ink-200 pt-4 space-y-2">
                <button
                  onClick={handleCheckForUpdates}
                  disabled={updateChecking}
                  className="h-10 px-6 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
                >
                  {updateChecking ? "جاري التحقق..." : "تحقق من التحديثات"}
                </button>
                {updateResult && (
                  <p className="text-sm font-arabic text-ink-700">{updateResult}</p>
                )}
              </div>
              <div className="border-t border-ink-200 pt-4 space-y-2">
                <button
                  onClick={handleSendDiagnostics}
                  disabled={diagnosticsSending}
                  className="h-10 px-6 rounded-sm border border-ink-300 text-ink-700 text-sm font-bold hover:bg-ink-100 transition-colors disabled:opacity-50"
                >
                  {diagnosticsSending ? "جاري الإرسال..." : "إرسال تقرير تشخيصي"}
                </button>
                <p className="text-xs font-arabic text-ink-400">
                  يرسل آخر سجل أخطاء من هذا الجهاز لفريق الدعم للمساعدة في حل مشكلة تواجهها -- لا يتم إرسال أي شيء تلقائياً
                </p>
                {diagnosticsResult && (
                  <p className="text-sm font-arabic text-ink-700">{diagnosticsResult}</p>
                )}
              </div>
              <div className="border-t border-ink-200 pt-4">
                <p className="text-sm font-arabic text-ink-900 mb-2">الدعم الفني</p>
                <a
                  href="mailto:support@wenzdes.com"
                  className="text-saffron-600 hover:underline font-arabic text-sm"
                  dir="ltr"
                >
                  support@wenzdes.com
                </a>
              </div>
            </div>
          </div>
        )}
        </>
        )}
      </div>

      {message && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-saffron-600 text-white px-6 py-3 rounded-sm z-50 font-arabic">
          {message}
        </div>
      )}
    </div>
  );
}
