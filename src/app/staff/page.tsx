import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { useAuthStore } from "../../stores/authStore";
import type { UserRole } from "../../db/types";
import QRCode from "qrcode";
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

type Tab = "employees" | "shifts" | "attendance";

// Matches Rust's `repo::StaffRow` -- `staff` (T1.1) replaced `users`
// (dropped by Decision A, 2026-07-16) and has no `email`/`phone`/
// `photo_path`/`cv_path`/`qr_code` columns; the old employee form's fields
// for those are gone, not silently unsaved (see `saveEmployee` below).
interface Employee {
  id: string;
  name: string;
  role: UserRole;
  role_rank: number;
  branch_id: string | null;
  is_active: number;
  created_at: string;
}

interface Shift {
  id: string;
  user_id: string;
  opened_at: string;
  closed_at: string | null;
  starting_cash_cents: number;
  ending_cash_cents: number | null;
  difference_cents: number | null;
  user_name: string;
}

interface Attendance {
  id: string;
  user_id: string;
  date: string;
  clock_in: string | null;
  clock_out: string | null;
  status: string;
  user_name: string;
}

const ROLE_COLORS: Record<UserRole, string> = {
  OWNER: "bg-purple-100 text-purple-700",
  MANAGER: "bg-blue-100 text-blue-700",
  CASHIER: "bg-saffron-100 text-saffron-600",
  ADMIN: "bg-amber-100 text-amber-700",
  ACCOUNTANT: "bg-white text-ink-900",
  KITCHEN: "bg-white text-ink-900",
};

const ROLE_NAMES: Record<UserRole, string> = {
  OWNER: "مالك",
  MANAGER: "مدير",
  CASHIER: "كاشير",
  ADMIN: "مشرف",
  ACCOUNTANT: "محاسب",
  KITCHEN: "مطبخ",
};

// `staff`'s own CHECK constraint allows PLATFORM/OWNER/MANAGER/CASHIER/
// KITCHEN/SERVER -- ADMIN/ACCOUNTANT no longer exist as assignable roles
// (Migration C folded both into MANAGER permanently); PLATFORM/SERVER are
// not offered here (Platform is a cross-tenant role this UI has no business
// creating; SERVER isn't in `UserRole` yet).
const employeeSchema = z.object({
  name: z.string().min(1, "الاسم مطلوب"),
  role: z.enum(["CASHIER", "MANAGER", "OWNER", "KITCHEN"]),
  // Login is PIN-only now (the old username/password path is gone) -- every
  // staff member needs a working PIN, not just managers, so this is
  // required on create. Left blank on edit means "don't change the PIN".
  pin: z.string().regex(/^\d{6}$/, "الرقم السري يجب أن يكون 6 أرقام").or(z.literal("")),
  is_active: z.boolean(),
});

type EmployeeForm = z.infer<typeof employeeSchema>;

const emptyEmployeeForm: EmployeeForm = {
  name: "",
  role: "CASHIER",
  pin: "",
  is_active: true,
};

const DIFF_THRESHOLD_CENTS = 5000;

function formatTime(iso: string | null): string {
  if (!iso) return "---";
  return new Date(iso).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string | null): string {
  if (!iso) return "---";
  return new Date(iso).toLocaleDateString("ar-SA", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "---";
  return `${formatDate(iso)} ${formatTime(iso)}`;
}

function formatDuration(clockIn: string | null, clockOut: string | null): string {
  if (!clockIn) return "---";
  const start = new Date(clockIn).getTime();
  const end = clockOut ? new Date(clockOut).getTime() : Date.now();
  const diffMs = Math.max(0, end - start);
  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  return `${hours}s ${minutes}m`;
}

function formatCents(cents: number | null): string {
  if (cents === null) return "---";
  return new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR" }).format(cents / 100);
}

export default function StaffPage() {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const [tab, setTab] = useState<Tab>("employees");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);

  const [showEmployeeModal, setShowEmployeeModal] = useState(false);
  const [editEmployeeId, setEditEmployeeId] = useState<string | null>(null);
  const [employeeForm, setEmployeeForm] = useState<EmployeeForm>(emptyEmployeeForm);
  const [employeeErrors, setEmployeeErrors] = useState<Record<string, string>>({});
  const [savingEmployee, setSavingEmployee] = useState(false);

  const [deleteEmployeeId, setDeleteEmployeeId] = useState<string | null>(null);
  const [qrDataUrls, setQrDataUrls] = useState<Record<string, string>>({});

  const [shiftDateFrom, setShiftDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [shiftDateTo, setShiftDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [shiftEmployeeFilter, setShiftEmployeeFilter] = useState("");
  const [forceCloseShiftId, setForceCloseShiftId] = useState<string | null>(null);

  const [clockingUserId, setClockingUserId] = useState<string | null>(null);
  const [attendanceSubTab, setAttendanceSubTab] = useState<"today" | "history">("today");
  const [attendanceDateFrom, setAttendanceDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
  });
  const [attendanceDateTo, setAttendanceDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [attendanceEmployeeFilter, setAttendanceEmployeeFilter] = useState("");

  const fetchEmployees = useCallback(async () => {
    try {
      const rows = await invoke<Employee[]>("list_staff_v3", { sessionToken: token });
      setEmployees(rows);
      for (const emp of rows) {
        if (!qrDataUrls[emp.id]) {
          QRCode.toDataURL(emp.id, { width: 256, margin: 1, color: { dark: "#1e293b" } }).then((url: string) => {
            setQrDataUrls((prev) => ({ ...prev, [emp.id]: url }));
          }).catch(() => {});
        }
      }
    } catch {
      setError("حدث خطأ في تحميل الموظفين");
    }
  }, [token]);

  const fetchShifts = useCallback(async () => {
    try {
      const rows = await invoke<Shift[]>("list_shifts_v3", {
        sessionToken: token,
        dateFrom: shiftDateFrom ? new Date(shiftDateFrom).toISOString() : null,
        dateTo: shiftDateTo ? (() => { const d = new Date(shiftDateTo); d.setHours(23, 59, 59, 999); return d.toISOString(); })() : null,
        userId: shiftEmployeeFilter || null,
      });
      setShifts(rows);
    } catch {
      setError("حدث خطأ في تحميل الورديات");
    }
  }, [token, shiftDateFrom, shiftDateTo, shiftEmployeeFilter]);

  const fetchAttendance = useCallback(async (fromDate?: string, toDate?: string) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const f = fromDate || today;
      const t = toDate || today;
      const rows = await invoke<Attendance[]>("list_attendance_v3", {
        sessionToken: token,
        dateFrom: f,
        dateTo: t,
        userId: attendanceEmployeeFilter || null,
      });
      setAttendance(rows);
    } catch {
      setError("حدث خطأ في تحميل الحضور");
    }
  }, [token, attendanceEmployeeFilter]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([fetchEmployees(), fetchShifts(), fetchAttendance()]);
    } finally {
      setLoading(false);
    }
  }, [fetchEmployees, fetchShifts, fetchAttendance]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (tab === "shifts") fetchShifts();
  }, [tab, fetchShifts]);

  useEffect(() => {
    if (tab === "attendance") {
      if (attendanceSubTab === "today") fetchAttendance();
      else fetchAttendance(attendanceDateFrom, attendanceDateTo);
    }
  }, [tab, attendanceSubTab, attendanceDateFrom, attendanceDateTo, fetchAttendance]);

  const openAddEmployee = () => {
    setEditEmployeeId(null);
    setEmployeeForm(emptyEmployeeForm);
    setEmployeeErrors({});
    setShowEmployeeModal(true);
  };

  const openEditEmployee = (emp: Employee) => {
    setEditEmployeeId(emp.id);
    setEmployeeForm({
      name: emp.name,
      role: emp.role as EmployeeForm["role"],
      pin: "",
      is_active: !!emp.is_active,
    });
    setEmployeeErrors({});
    setShowEmployeeModal(true);
  };

  const saveEmployee = async () => {
    const parsed = employeeSchema.safeParse(employeeForm);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as string;
        errs[field] = issue.message;
      }
      setEmployeeErrors(errs);
      return;
    }
    if (!editEmployeeId && !parsed.data.pin) {
      setEmployeeErrors({ pin: "الرقم السري مطلوب لموظف جديد" });
      return;
    }
    setSavingEmployee(true);
    try {
      if (editEmployeeId) {
        const original = employees.find((e) => e.id === editEmployeeId);
        await invoke("update_staff_profile_v3", {
          sessionToken: token,
          targetStaffId: editEmployeeId,
          name: parsed.data.name,
          newPin: parsed.data.pin || null,
        });
        if (original && original.role !== parsed.data.role) {
          await invoke("update_staff_v3", { sessionToken: token, targetStaffId: editEmployeeId, newRole: parsed.data.role });
        }
        if (original && !!original.is_active !== parsed.data.is_active) {
          await invoke("set_staff_active_v3", { sessionToken: token, targetStaffId: editEmployeeId, isActive: parsed.data.is_active });
        }
      } else {
        const branches = await invoke<[string, string][]>("list_branches_v3", { sessionToken: token });
        const targetBranchId = branches[0]?.[0] ?? null;
        const newId = await invoke<string>("create_staff_v3", {
          sessionToken: token,
          targetBranchId,
          role: parsed.data.role,
          name: parsed.data.name,
          pin: parsed.data.pin,
        });
        QRCode.toDataURL(newId, { width: 256, margin: 1, color: { dark: "#1e293b" } }).then((url: string) => {
          setQrDataUrls((prev) => ({ ...prev, [newId]: url }));
        }).catch(() => {});
      }
      setShowEmployeeModal(false);
      await fetchEmployees();
    } catch (err) {
      setEmployeeErrors({ _form: typeof err === "string" ? err : "حدث خطأ في الحفظ" });
    } finally {
      setSavingEmployee(false);
    }
  };

  const confirmDeleteEmployee = async () => {
    if (!deleteEmployeeId) return;
    try {
      await invoke("set_staff_active_v3", { sessionToken: token, targetStaffId: deleteEmployeeId, isActive: false });
      setDeleteEmployeeId(null);
      await fetchEmployees();
    } catch {
      setError("حدث خطأ في الحذف");
    }
  };

  const toggleEmployeeStatus = async (emp: Employee) => {
    try {
      await invoke("set_staff_active_v3", { sessionToken: token, targetStaffId: emp.id, isActive: !emp.is_active });
      await fetchEmployees();
    } catch {
      setError("حدث خطأ في تحديث الحالة");
    }
  };

  const forceCloseShift = async (shiftId: string) => {
    if (!user) return;
    try {
      await invoke("force_close_shift_v3", { sessionToken: token, shiftId });
      setForceCloseShiftId(null);
      await fetchShifts();
    } catch {
      setError("حدث خطأ في إغلاق الوردية");
    }
  };

  const handleClockIn = async (userId: string) => {
    setClockingUserId(userId);
    try {
      await invoke("clock_in_v3", { sessionToken: token, userId });
      await fetchAttendance();
    } catch {
      setError("حدث خطأ في تسجيل الحضور");
    } finally {
      setClockingUserId(null);
    }
  };

  const handleClockOut = async (userId: string) => {
    setClockingUserId(userId);
    try {
      await invoke("clock_out_v3", { sessionToken: token, userId });
      await fetchAttendance();
    } catch {
      setError("حدث خطأ في تسجيل الانصراف");
    } finally {
      setClockingUserId(null);
    }
  };

  const getAttendanceForUser = (userId: string) => {
    return attendance.find((a) => a.user_id === userId);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-ink-500 font-arabic">
        جاري التحميل...
      </div>
    );
  }

  if (error && employees.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-red-500 font-arabic">
        {error}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">إدارة الموظفين</h1>
        {tab === "employees" && (
          <button
            onClick={openAddEmployee}
            className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
          >
            + إضافة موظف
          </button>
        )}
      </div>

      <div className="flex gap-2 border-b border-ink-200 pb-2">
        {(["employees", "shifts", "attendance"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-t-lg font-arabic font-medium text-sm transition-colors ${
              tab === t
                ? "bg-saffron-600 text-white shadow-sm"
                : "text-ink-500 hover:text-saffron-600 hover:bg-white"
            }`}
          >
            {t === "employees"
              ? "الموظفون"
              : t === "shifts"
                ? "الورديات"
                : "الحضور والانصراف"}
          </button>
        ))}
      </div>

      {/* TAB: Employees */}
      {tab === "employees" && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-ink-400 font-arabic">
                  <th className="text-right p-3 font-medium">الاسم</th>
                  <th className="text-right p-3 font-medium">الدور</th>
                  <th className="text-center p-3 font-medium">الحالة</th>
                  <th className="text-right p-3 font-medium">تاريخ التسجيل</th>
                  <th className="text-center p-3 font-medium">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((emp) => (
                  <tr key={emp.id} className="border-b border-ink-200 hover:bg-white">
                    <td className="p-3 font-arabic text-ink-900 font-medium">
                      <span>{emp.name}</span>
                    </td>
                    <td className="p-3">
                      <span
                        className={`inline-block px-3 py-1 rounded-full text-xs font-arabic font-medium ${ROLE_COLORS[emp.role]}`}
                      >
                        {ROLE_NAMES[emp.role]}
                      </span>
                    </td>
                    <td className="p-3 text-center">
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${emp.is_active ? "bg-saffron-600" : "bg-red-400"}`}
                      />
                    </td>
                    <td className="p-3 font-arabic text-ink-400 text-xs">
                      {formatDate(emp.created_at)}
                    </td>
                    <td className="p-3 text-center">
                      <div className="flex items-center justify-center gap-2">
                        {qrDataUrls[emp.id] && (
                          <div className="relative group">
                            <button className="p-1.5 rounded-lg text-ink-500 hover:text-purple-600 hover:bg-purple-50 transition-colors" title="QR">
                              📱
                            </button>
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50">
                              <div className="bg-white p-2 rounded-xl shadow-xl border border-ink-200">
                                <img src={qrDataUrls[emp.id]} alt="QR" className="w-32 h-32" />
                              </div>
                            </div>
                          </div>
                        )}
                        <button
                          onClick={() => openEditEmployee(emp)}
                          className="p-1.5 rounded-lg text-ink-500 hover:text-saffron-600 hover:bg-saffron-50 transition-colors"
                          title="تعديل"
                        >
                          ✏️
                        </button>
                        <button
                          onClick={() => toggleEmployeeStatus(emp)}
                          className={`px-3 py-1 rounded-lg text-xs font-arabic transition-colors ${
                            emp.is_active
                              ? "text-amber-600 hover:bg-amber-50"
                              : "text-saffron-600 hover:bg-saffron-50"
                          }`}
                        >
                          {emp.is_active ? "🔒 تعليق" : "تفعيل"}
                        </button>
                        <button
                          onClick={() => setDeleteEmployeeId(emp.id)}
                          className="p-1.5 rounded-lg text-ink-500 hover:text-red-500 hover:bg-red-50 transition-colors"
                          title="حذف"
                        >
                          🗑️
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {employees.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-ink-500 font-arabic">
                      لا يوجد موظفون
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB: Shifts */}
      {tab === "shifts" && (
        <div className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm font-arabic text-ink-500">من</label>
              <input
                type="date"
                value={shiftDateFrom}
                onChange={(e) => setShiftDateFrom(e.target.value)}
                className="h-10 px-3 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-arabic text-ink-500">إلى</label>
              <input
                type="date"
                value={shiftDateTo}
                onChange={(e) => setShiftDateTo(e.target.value)}
                className="h-10 px-3 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
              />
            </div>
            <select
              value={shiftEmployeeFilter}
              onChange={(e) => setShiftEmployeeFilter(e.target.value)}
              className="h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
            >
              <option value="">كل الموظفين</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
            </select>
          </div>

          <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-ink-400 font-arabic">
                  <th className="text-right p-3 font-medium">الموظف</th>
                  <th className="text-right p-3 font-medium">بداية الوردية</th>
                  <th className="text-right p-3 font-medium">نهاية الوردية</th>
                  <th className="text-right p-3 font-medium">الرصيد الافتتاحي</th>
                  <th className="text-right p-3 font-medium">الرصيد الفعلي</th>
                  <th className="text-right p-3 font-medium">الفرق</th>
                  <th className="text-center p-3 font-medium">الحالة</th>
                  <th className="text-center p-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((shift) => {
                  const isOpen = !shift.closed_at;
                  const diff = shift.difference_cents;
                  const needsReview =
                    !isOpen && diff !== null && Math.abs(diff) > DIFF_THRESHOLD_CENTS;
                  return (
                    <tr key={shift.id} className="border-b border-ink-200 hover:bg-white">
                      <td className="p-3 font-arabic text-ink-900">{shift.user_name}</td>
                      <td className="p-3 font-mono text-ink-900 text-xs">
                        {formatDateTime(shift.opened_at)}
                      </td>
                      <td className="p-3 font-mono text-ink-900 text-xs">
                        {formatDateTime(shift.closed_at)}
                      </td>
                      <td className="p-3 font-mono text-ink-900">
                        {formatCents(shift.starting_cash_cents)}
                      </td>
                      <td className="p-3 font-mono text-ink-900">
                        {formatCents(shift.ending_cash_cents)}
                      </td>
                      <td className="p-3">
                        <span
                          className={`font-mono font-bold ${
                            diff !== null && diff < 0 ? "text-red-500" : diff !== null && diff > 0 ? "text-saffron-600" : "text-ink-400"
                          }`}
                        >
                          {formatCents(shift.difference_cents)}
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <span
                          className={`inline-block px-3 py-1 rounded-full text-xs font-arabic font-medium ${
                            needsReview
                              ? "bg-red-100 text-red-700"
                              : isOpen
                                ? "bg-amber-100 text-amber-700"
                                : "bg-saffron-100 text-saffron-600"
                          }`}
                        >
                          {needsReview
                            ? "تحت المراجعة"
                            : isOpen
                              ? "مفتوحة"
                              : "مغلقة"}
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        {isOpen && user?.role === "MANAGER" && (
                          <button
                            onClick={() => setForceCloseShiftId(shift.id)}
                            className="px-3 py-1 rounded-lg text-xs font-arabic text-amber-600 hover:bg-amber-50 transition-colors"
                          >
                            إغلاق قسري
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {shifts.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-6 text-center text-ink-500 font-arabic">
                      لا توجد ورديات
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB: Attendance */}
      {tab === "attendance" && (
        <div className="space-y-4">
          <div className="flex gap-2 border-b border-ink-200 pb-2">
            {(["today", "history"] as const).map((st) => (
              <button
                key={st}
                onClick={() => setAttendanceSubTab(st)}
                className={`px-5 py-2 rounded-t-lg font-arabic font-medium text-sm transition-colors ${
                  attendanceSubTab === st
                    ? "bg-saffron-600 text-white shadow-sm"
                    : "text-ink-500 hover:text-saffron-600 hover:bg-white"
                }`}
              >
                {st === "today" ? "اليوم" : "سجل الحضور"}
              </button>
            ))}
          </div>

          {attendanceSubTab === "today" && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {employees.filter((e) => e.is_active).map((emp) => {
                  const record = getAttendanceForUser(emp.id);
                  const isPresent = (record?.status === "PRESENT" || record?.status === "LATE") && !!record?.clock_in;
                  const isClockedIn = isPresent && !record?.clock_out;
                  const attStatus = record?.status ?? "ABSENT";
                  const statusColors: Record<string, string> = {
                    PRESENT: "bg-saffron-100 text-saffron-600",
                    LATE: "bg-amber-100 text-amber-700",
                    HALF_DAY: "bg-orange-100 text-orange-700",
                    ABSENT: "bg-white text-ink-400",
                  };
                  const statusLabels: Record<string, string> = {
                    PRESENT: "حاضر",
                    LATE: "متأخر",
                    HALF_DAY: "نصف يوم",
                    ABSENT: "غائب",
                  };
                  return (
                    <div
                      key={emp.id}
                      className="bg-white rounded-2xl shadow-sm p-5 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span
                            className={`inline-block w-3 h-3 rounded-full ${
                              isPresent ? "bg-saffron-600" : "bg-ink-300"
                            }`}
                          />
                          <span className="font-arabic font-bold text-ink-900">{emp.name}</span>
                        </div>
                        <span
                          className={`inline-block px-3 py-1 rounded-full text-xs font-arabic font-medium ${statusColors[attStatus]}`}
                        >
                          {statusLabels[attStatus]}
                        </span>
                      </div>

                      {record && (
                        <div className="space-y-1 text-xs text-ink-400 font-arabic">
                          <div className="flex justify-between">
                            <span>الحضور</span>
                            <span className="font-mono" dir="ltr">{formatTime(record.clock_in)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>الانصراف</span>
                            <span className="font-mono" dir="ltr">{formatTime(record.clock_out)}</span>
                          </div>
                          <div className="flex justify-between font-medium text-ink-900">
                            <span>المدة</span>
                            <span className="font-mono">{formatDuration(record.clock_in, record.clock_out)}</span>
                          </div>
                        </div>
                      )}

                      {!record && (
                        <p className="text-xs text-ink-500 font-arabic text-center py-2">
                          لم يسجل حضور اليوم
                        </p>
                      )}

                      <div className="flex gap-2">
                        {!isClockedIn && (
                          <button
                            onClick={() => handleClockIn(emp.id)}
                            disabled={clockingUserId === emp.id}
                            className="flex-1 h-11 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
                          >
                            {clockingUserId === emp.id ? "..." : "تسجيل دخول"}
                          </button>
                        )}
                        {isClockedIn && (
                          <button
                            onClick={() => handleClockOut(emp.id)}
                            disabled={clockingUserId === emp.id}
                            className="flex-1 h-11 rounded-xl bg-amber-600 text-white text-sm font-bold hover:bg-amber-700 transition-colors disabled:opacity-50"
                          >
                            {clockingUserId === emp.id ? "..." : "تسجيل خروج"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 text-ink-400 font-arabic">
                      <th className="text-right p-3 font-medium">الموظف</th>
                      <th className="text-right p-3 font-medium">وقت الحضور</th>
                      <th className="text-right p-3 font-medium">وقت الانصراف</th>
                      <th className="text-right p-3 font-medium">المدة</th>
                      <th className="text-center p-3 font-medium">الحالة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendance.map((rec) => {
                      const sc: Record<string, string> = {
                        PRESENT: "bg-saffron-100 text-saffron-600",
                        LATE: "bg-amber-100 text-amber-700",
                        HALF_DAY: "bg-orange-100 text-orange-700",
                        ABSENT: "bg-white text-ink-400",
                      };
                      const sl: Record<string, string> = {
                        PRESENT: "حاضر",
                        LATE: "متأخر",
                        HALF_DAY: "نصف يوم",
                        ABSENT: "غائب",
                      };
                      return (
                        <tr key={rec.id} className="border-b border-ink-200 hover:bg-white">
                          <td className="p-3 font-arabic text-ink-900 font-medium">{rec.user_name}</td>
                          <td className="p-3 font-mono text-ink-900 text-xs" dir="ltr">{formatTime(rec.clock_in)}</td>
                          <td className="p-3 font-mono text-ink-900 text-xs" dir="ltr">{formatTime(rec.clock_out)}</td>
                          <td className="p-3 font-mono text-ink-900">{formatDuration(rec.clock_in, rec.clock_out)}</td>
                          <td className="p-3 text-center">
                            <span className={`inline-block px-3 py-1 rounded-full text-xs font-arabic font-medium ${sc[rec.status] ?? "bg-white text-ink-400"}`}>
                              {sl[rec.status] ?? "غائب"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                    {attendance.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-6 text-center text-ink-500 font-arabic">
                          لا يوجد تسجيل حضور اليوم
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {attendanceSubTab === "history" && (
            <div className="space-y-4">
              <div className="flex gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-arabic text-ink-500">من</label>
                  <input
                    type="date"
                    value={attendanceDateFrom}
                    onChange={(e) => setAttendanceDateFrom(e.target.value)}
                    className="h-10 px-3 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm font-arabic text-ink-500">إلى</label>
                  <input
                    type="date"
                    value={attendanceDateTo}
                    onChange={(e) => setAttendanceDateTo(e.target.value)}
                    className="h-10 px-3 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
                  />
                </div>
                <select
                  value={attendanceEmployeeFilter}
                  onChange={(e) => setAttendanceEmployeeFilter(e.target.value)}
                  className="h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                >
                  <option value="">كل الموظفين</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => fetchAttendance(attendanceDateFrom, attendanceDateTo)}
                  className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
                >
                  بحث
                </button>
              </div>

              <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 text-ink-400 font-arabic">
                      <th className="text-right p-3 font-medium">التاريخ</th>
                      <th className="text-right p-3 font-medium">الموظف</th>
                      <th className="text-right p-3 font-medium">الحضور</th>
                      <th className="text-right p-3 font-medium">الانصراف</th>
                      <th className="text-right p-3 font-medium">المدة</th>
                      <th className="text-center p-3 font-medium">الحالة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendance.map((rec) => {
                      const sc: Record<string, string> = {
                        PRESENT: "bg-saffron-100 text-saffron-600",
                        LATE: "bg-amber-100 text-amber-700",
                        HALF_DAY: "bg-orange-100 text-orange-700",
                        ABSENT: "bg-white text-ink-400",
                      };
                      const sl: Record<string, string> = {
                        PRESENT: "حاضر",
                        LATE: "متأخر",
                        HALF_DAY: "نصف يوم",
                        ABSENT: "غائب",
                      };
                      return (
                        <tr key={rec.id} className="border-b border-ink-200 hover:bg-white">
                          <td className="p-3 font-mono text-ink-500 text-xs">{rec.date}</td>
                          <td className="p-3 font-arabic text-ink-900 font-medium">{rec.user_name}</td>
                          <td className="p-3 font-mono text-ink-900 text-xs" dir="ltr">{formatTime(rec.clock_in)}</td>
                          <td className="p-3 font-mono text-ink-900 text-xs" dir="ltr">{formatTime(rec.clock_out)}</td>
                          <td className="p-3 font-mono text-ink-900">{formatDuration(rec.clock_in, rec.clock_out)}</td>
                          <td className="p-3 text-center">
                            <span className={`inline-block px-3 py-1 rounded-full text-xs font-arabic font-medium ${sc[rec.status] ?? "bg-white text-ink-400"}`}>
                              {sl[rec.status] ?? "غائب"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                    {attendance.length === 0 && (
                      <tr>
                        <td colSpan={6} className="p-6 text-center text-ink-500 font-arabic">
                          لا توجد سجلات حضور
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Employee Modal */}
      {showEmployeeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">
              {editEmployeeId ? "تعديل موظف" : "إضافة موظف"}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">الاسم *</label>
                <input
                  type="text"
                  value={employeeForm.name}
                  onChange={(e) => setEmployeeForm((p) => ({ ...p, name: e.target.value }))}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                />
                {employeeErrors.name && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{employeeErrors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">الدور *</label>
                <select
                  value={employeeForm.role}
                  onChange={(e) =>
                    setEmployeeForm((p) => ({ ...p, role: e.target.value as EmployeeForm["role"] }))
                  }
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                >
                  {(["CASHIER", "KITCHEN", "MANAGER", "OWNER"] as const).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_NAMES[r]}
                    </option>
                  ))}
                </select>
                {employeeErrors.role && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">{employeeErrors.role}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">
                  الرقم السري لتسجيل الدخول (6 أرقام) {!editEmployeeId ? "*" : "(اتركه فارغاً إذا لم ترد التغيير)"}
                </label>
                <input
                  type="password"
                  value={employeeForm.pin}
                  onChange={(e) => setEmployeeForm((p) => ({ ...p, pin: e.target.value }))}
                  maxLength={6}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500"
                  dir="ltr"
                />
                {employeeErrors.pin && (
                  <p className="text-xs text-red-500 mt-1 font-arabic">
                    {employeeErrors.pin}
                  </p>
                )}
              </div>

              {editEmployeeId && (
                <div className="flex items-center gap-3">
                  <label className="text-sm font-arabic text-ink-900">نشط</label>
                  <button
                    onClick={() =>
                      setEmployeeForm((p) => ({ ...p, is_active: !p.is_active }))
                    }
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      employeeForm.is_active ? "bg-saffron-600" : "bg-ink-300"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        employeeForm.is_active ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>
              )}

              {employeeErrors._form && (
                <p className="text-sm text-red-500 font-arabic">{employeeErrors._form}</p>
              )}
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowEmployeeModal(false)}
                className="h-10 px-6 rounded-xl bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={saveEmployee}
                disabled={savingEmployee}
                className="h-10 px-6 rounded-xl bg-saffron-600 text-white font-arabic text-sm hover:bg-saffron-700 transition-colors disabled:opacity-50"
              >
                {savingEmployee ? "جاري الحفظ..." : "حفظ"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Employee Confirmation */}
      {deleteEmployeeId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">تأكيد التعليق</h2>
            <p className="text-sm font-arabic text-ink-500">
              هل أنت متأكد من تعليق هذا الموظف؟ (حذف ناعم)
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteEmployeeId(null)}
                className="h-10 px-6 rounded-xl bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={confirmDeleteEmployee}
                className="h-10 px-6 rounded-xl bg-red-500 text-white font-arabic text-sm hover:bg-red-600 transition-colors"
              >
                تعليق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Force Close Shift Confirmation */}
      {forceCloseShiftId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">إغلاق قسري للوردية</h2>
            <p className="text-sm font-arabic text-ink-500">
              هل أنت متأكد من إغلاق هذه الوردية قسرياً؟ سيتم تعيين الرصيد الفعلي إلى 0.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setForceCloseShiftId(null)}
                className="h-10 px-6 rounded-xl bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={() => forceCloseShift(forceCloseShiftId)}
                className="h-10 px-6 rounded-xl bg-amber-600 text-white font-arabic text-sm hover:bg-amber-700 transition-colors"
              >
                إغلاق قسري
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
