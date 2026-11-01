import { useCallback, useEffect, useState } from "react";
import { IconFingerprint, IconX } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { formatArabicDate, formatArabicTime, toLocalDateStr } from "../../lib/dateLocal";

interface Employee {
  id: string;
  name: string;
  is_active: number;
}

interface FingerprintStatus {
  connected: boolean;
  model: string | null;
  message: string;
  enrolled_people: number;
}

interface Enrolment {
  id: string;
  user_id: string;
  user_name: string;
  finger: string;
  provider: string;
  enrolled_at: string;
}

interface Punch {
  id: string;
  user_id: string;
  user_name: string;
  punched_at: string;
  direction: "IN" | "OUT";
  source: "MANUAL" | "FINGERPRINT" | "DEVICE_IMPORT";
  recorded_by_name: string | null;
}

interface PunchOutcome {
  user_name: string;
  direction: "IN" | "OUT";
  status: string;
}

interface Settings {
  shift_start: string;
  late_grace_minutes: number;
  min_gap_seconds: number;
}

const FINGERS: [string, string][] = [
  ["right_index", "سبابة اليمين"],
  ["right_thumb", "إبهام اليمين"],
  ["right_middle", "وسطى اليمين"],
  ["right_ring", "بنصر اليمين"],
  ["right_little", "خنصر اليمين"],
  ["left_index", "سبابة اليسار"],
  ["left_thumb", "إبهام اليسار"],
  ["left_middle", "وسطى اليسار"],
  ["left_ring", "بنصر اليسار"],
  ["left_little", "خنصر اليسار"],
];
const fingerName = (f: string) => FINGERS.find(([k]) => k === f)?.[1] ?? f;

const SOURCE_LABEL: Record<Punch["source"], string> = { MANUAL: "يدوي", FINGERPRINT: "بصمة", DEVICE_IMPORT: "جهاز خارجي" };

/**
 * Staff > Attendance > fingerprint: whether a reader is connected, who has a finger
 * enrolled, the late rule, and the log of every punch whatever its source. The reader
 * driver is not chosen yet, so enrolling and punching report "no device" plainly.
 */
export default function FingerprintPanel({ employees }: { employees: Employee[] }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();

  const [status, setStatus] = useState<FingerprintStatus | null>(null);
  const [enrolments, setEnrolments] = useState<Enrolment[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [shiftStart, setShiftStart] = useState("09:00");
  const [grace, setGrace] = useState("10");
  const [fingerFor, setFingerFor] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return toLocalDateStr(d);
  });

  const load = useCallback(async () => {
    try {
      const [s, e, p, cfg] = await Promise.all([
        invoke<FingerprintStatus>("fingerprint_status_v3", { sessionToken: token }),
        invoke<Enrolment[]>("list_fingerprint_enrolments_v3", { sessionToken: token }),
        invoke<Punch[]>("list_punches_v3", { sessionToken: token, dateFrom: from, dateTo: null, userId: null }),
        invoke<Settings>("get_attendance_settings_v3", { sessionToken: token }),
      ]);
      setStatus(s);
      setEnrolments(e);
      setPunches(p);
      setSettings(cfg);
      setShiftStart(cfg.shift_start);
      setGrace(String(cfg.late_grace_minutes));
    } catch (err) {
      toast.error(`تعذر تحميل بيانات البصمة: ${realErrorText(err)}`);
    }
  }, [token, from, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const connected = !!status?.connected;

  const saveSettings = async () => {
    setBusy("settings");
    try {
      await invoke("set_attendance_settings_v3", { sessionToken: token, shiftStart, lateGraceMinutes: Number(grace) });
      toast.success("تم حفظ قاعدة التأخير ✓");
      await load();
    } catch (err) {
      toast.error(realErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  const enrol = async (userId: string) => {
    setBusy(`enrol-${userId}`);
    try {
      await invoke("enrol_fingerprint_v3", { sessionToken: token, userId, finger: fingerFor[userId] ?? "right_index" });
      toast.success("تم تسجيل البصمة ✓");
      await load();
    } catch (err) {
      toast.error(realErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  const removeEnrolment = async (id: string) => {
    setBusy(`del-${id}`);
    try {
      await invoke("delete_fingerprint_enrolment_v3", { sessionToken: token, enrolmentId: id });
      toast.success("تم حذف البصمة");
      await load();
    } catch (err) {
      toast.error(realErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  const punchNow = async () => {
    setBusy("punch");
    try {
      const r = await invoke<PunchOutcome>("fingerprint_punch_v3", { sessionToken: token });
      toast.success(`${r.user_name}: ${r.direction === "IN" ? "تم تسجيل الحضور" : "تم تسجيل الانصراف"}${r.status === "LATE" ? " (متأخر)" : ""} ✓`);
      await load();
    } catch (err) {
      toast.error(realErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  const active = employees.filter((e) => e.is_active);

  return (
    <div className="space-y-5" data-testid="fingerprint-panel">
      <div className={`zc-card p-4 flex items-center justify-between gap-4 flex-wrap ${connected ? "" : "border-amber-300"}`}>
        <div className="flex items-start gap-3 min-w-0">
          <IconFingerprint className={`w-8 h-8 shrink-0 ${connected ? "text-saffron-600" : "text-amber-600"}`} stroke={1.5} />
          <div className="min-w-0">
            <p className="font-arabic font-bold text-ink-900" data-testid="fingerprint-status">
              {connected ? `جهاز البصمة متصل${status?.model ? `: ${status.model}` : ""}` : "لا يوجد جهاز بصمة متصل"}
            </p>
            <p className="text-sm text-ink-500 font-arabic">
              {connected ? `${status?.enrolled_people ?? 0} موظف مسجّل بصمته` : (status?.message ?? "")}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={punchNow}
          disabled={busy === "punch"}
          data-testid="fingerprint-punch"
          className="h-11 px-5 rounded-sm bg-accent text-white font-arabic font-bold active:scale-[0.98] disabled:opacity-50"
        >
          بصمة الحضور / الانصراف
        </button>
      </div>

      <div className="zc-card p-4 space-y-3">
        <h3 className="font-arabic font-bold text-ink-900">قاعدة التأخير</h3>
        <p className="text-sm text-ink-500 font-arabic">من يصل بعد بداية الدوام بأكثر من المهلة يُسجَّل «متأخر». التوقيت هو توقيت هذا الجهاز.</p>
        <div className="flex items-end gap-3 flex-wrap">
          <label className="block">
            <span className="block text-xs text-ink-500 font-arabic mb-1">بداية الدوام</span>
            <input
              type="time"
              value={shiftStart}
              onChange={(e) => setShiftStart(e.target.value)}
              dir="ltr"
              data-testid="attendance-shift-start"
              className="h-10 px-3 rounded-sm border-2 border-ink-200 focus:border-saffron-500 outline-none font-mono"
            />
          </label>
          <label className="block">
            <span className="block text-xs text-ink-500 font-arabic mb-1">مهلة التأخير (دقيقة)</span>
            <input
              type="number"
              min={0}
              max={180}
              value={grace}
              onChange={(e) => setGrace(e.target.value)}
              dir="ltr"
              data-testid="attendance-grace"
              className="h-10 w-28 px-3 rounded-sm border-2 border-ink-200 focus:border-saffron-500 outline-none font-mono"
            />
          </label>
          <button
            type="button"
            onClick={saveSettings}
            disabled={busy === "settings" || !shiftStart || (settings?.shift_start === shiftStart && String(settings?.late_grace_minutes) === grace)}
            data-testid="attendance-settings-save"
            className="h-10 px-5 rounded-sm bg-saffron-600 text-white font-arabic font-bold disabled:opacity-40 active:scale-[0.98]"
          >
            حفظ
          </button>
        </div>
      </div>

      <div className="zc-card overflow-x-auto">
        <div className="p-4 border-b border-ink-200">
          <h3 className="font-arabic font-bold text-ink-900">بصمات الموظفين</h3>
          {!connected && <p className="text-sm text-amber-700 font-arabic mt-1">تسجيل البصمة يحتاج جهاز بصمة متصلاً. سيُفعَّل هذا الزر بعد تركيب الجهاز.</p>}
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-alt border-b border-ink-200 text-ink-400 font-arabic">
              <th className="text-right p-3 font-medium">الموظف</th>
              <th className="text-right p-3 font-medium">البصمات المسجّلة</th>
              <th className="text-right p-3 font-medium">إضافة بصمة</th>
            </tr>
          </thead>
          <tbody>
            {active.map((emp) => {
              const mine = enrolments.filter((e) => e.user_id === emp.id);
              return (
                <tr key={emp.id} className="border-b border-ink-200">
                  <td className="p-3 font-arabic text-ink-900 font-medium">{emp.name}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1.5">
                      {mine.length === 0 && <span className="text-xs text-ink-400 font-arabic">لا شيء</span>}
                      {mine.map((e) => (
                        <span key={e.id} className="inline-flex items-center gap-1 pl-1 pr-2.5 py-1 rounded-full bg-saffron-50 text-saffron-700 text-xs font-arabic">
                          {fingerName(e.finger)}
                          <button
                            type="button"
                            onClick={() => removeEnrolment(e.id)}
                            disabled={busy === `del-${e.id}`}
                            aria-label={`حذف بصمة ${fingerName(e.finger)}`}
                            className="w-5 h-5 rounded-full hover:bg-saffron-100 flex items-center justify-center"
                          >
                            <IconX className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <select
                        value={fingerFor[emp.id] ?? "right_index"}
                        onChange={(e) => setFingerFor((p) => ({ ...p, [emp.id]: e.target.value }))}
                        className="h-9 px-2 rounded-sm border-2 border-ink-200 font-arabic text-xs bg-white"
                        aria-label="الإصبع"
                      >
                        {FINGERS.map(([k, label]) => (
                          <option key={k} value={k}>{label}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => enrol(emp.id)}
                        disabled={!connected || busy === `enrol-${emp.id}`}
                        title={connected ? "" : "لا يوجد جهاز بصمة متصل"}
                        data-testid="fingerprint-enrol"
                        className="h-9 px-3 rounded-sm bg-saffron-600 text-white text-xs font-arabic font-bold disabled:opacity-40 active:scale-[0.98]"
                      >
                        تسجيل
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {active.length === 0 && (
              <tr>
                <td colSpan={3} className="p-6 text-center text-ink-500 font-arabic">لا يوجد موظفون نشطون</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="zc-card overflow-x-auto">
        <div className="p-4 border-b border-ink-200 flex items-center justify-between gap-3 flex-wrap">
          <h3 className="font-arabic font-bold text-ink-900">سجل التسجيلات</h3>
          <label className="flex items-center gap-2 text-sm font-arabic text-ink-500">
            من
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              dir="ltr"
              className="h-9 px-2 rounded-sm border-2 border-ink-200 font-mono text-xs"
            />
          </label>
        </div>
        <table className="w-full text-sm" data-testid="punch-log">
          <thead>
            <tr className="bg-surface-alt border-b border-ink-200 text-ink-400 font-arabic">
              <th className="text-right p-3 font-medium">الوقت</th>
              <th className="text-right p-3 font-medium">الموظف</th>
              <th className="text-center p-3 font-medium">النوع</th>
              <th className="text-right p-3 font-medium">المصدر</th>
            </tr>
          </thead>
          <tbody>
            {punches.map((p) => {
              const at = new Date(p.punched_at);
              return (
                <tr key={p.id} className="border-b border-ink-200 hover:bg-saffron-50">
                  <td className="p-3 font-mono text-xs text-ink-700" dir="ltr">
                    {formatArabicDate(at, { month: "short", day: "numeric" })} {formatArabicTime(at)}
                  </td>
                  <td className="p-3 font-arabic text-ink-900 font-medium">{p.user_name}</td>
                  <td className="p-3 text-center">
                    <span className={`inline-block px-3 py-1 rounded-full text-xs font-arabic font-medium ${p.direction === "IN" ? "bg-saffron-100 text-saffron-700" : "bg-ink-100 text-ink-700"}`}>
                      {p.direction === "IN" ? "حضور" : "انصراف"}
                    </span>
                  </td>
                  <td className="p-3 font-arabic text-ink-500 text-xs">
                    {SOURCE_LABEL[p.source]}
                    {p.source === "MANUAL" && p.recorded_by_name ? ` (${p.recorded_by_name})` : ""}
                  </td>
                </tr>
              );
            })}
            {punches.length === 0 && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-ink-500 font-arabic">لا توجد تسجيلات في هذه الفترة</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
