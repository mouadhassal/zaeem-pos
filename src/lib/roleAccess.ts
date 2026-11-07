import { invoke } from "./invoke";
import { useAuthStore } from "../stores/authStore";

/** The roles the owner can configure, in the order of the table's columns. Must match `ROLE_KEYS` in role_access.rs. */
export const ACCESS_ROLES: { key: string; label: string }[] = [
  { key: "MANAGER", label: "المدير" },
  { key: "CASHIER", label: "الكاشير" },
  { key: "KITCHEN", label: "المطبخ" },
];

/** The areas of the table, in order. Keys must match `Feature::key` in role_access.rs. */
export const ACCESS_FEATURES: { key: string; label: string; hint: string }[] = [
  { key: "reports", label: "صفحة التقارير", hint: "المبيعات، الضيافة، الطلبات غير المستلمة والمساعد الذكي" },
  { key: "report_print", label: "طباعة التقرير على الطابعة", hint: "الشريط الطويل بكل ما بيع. يلزم معه فتح صفحة التقارير" },
  { key: "finance", label: "المالية", hint: "التكاليف والفواتير والأرباح" },
  { key: "inventory", label: "المخزون والمشتريات", hint: "المواد والموردون وأوامر الشراء ومخزون المنتجات" },
  { key: "menu", label: "تعديل القائمة", hint: "الأصناف والتصنيفات والإضافات والعروض والأسعار" },
  { key: "staff", label: "الموظفون والجدول", hint: "إضافة الموظفين وتعديلهم، الحضور وجدول الدوام" },
  { key: "refund", label: "استرداد الطلبات", hint: "إرجاع ثمن طلب مدفوع" },
  { key: "settings", label: "الإعدادات", hint: "الطابعات والضرائب وبيانات الفرع والتفضيلات" },
];

export interface AccessCell {
  role: string;
  feature: string;
  allowed: boolean;
}

function token(): string {
  return useAuthStore.getState().token ?? "";
}

export function getRoleAccess(): Promise<AccessCell[]> {
  return invoke<AccessCell[]>("get_role_access_v3", { sessionToken: token() });
}

export function saveRoleAccess(cells: AccessCell[]): Promise<void> {
  return invoke<void>("save_role_access_v3", { sessionToken: token(), cells });
}

/** The table with one box flipped: what the screen shows and sends. */
export function withCell(cells: AccessCell[], role: string, feature: string, allowed: boolean): AccessCell[] {
  return cells.map((c) => (c.role === role && c.feature === feature ? { ...c, allowed } : c));
}

export function cellOf(cells: AccessCell[], role: string, feature: string): boolean {
  return cells.find((c) => c.role === role && c.feature === feature)?.allowed ?? false;
}
