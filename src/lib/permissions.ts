import type { UserRole } from "../db/types";

export interface SidebarNavItem {
  id: string;
  label: string;
  icon: string;
  allowed: boolean;
  readOnly?: boolean;
}

const CASHIER_NAV: SidebarNavItem[] = [
  { id: "pos", label: "نقاط البيع", icon: "calculator", allowed: true },
  { id: "shift", label: "الوردية", icon: "clock", allowed: true },
  { id: "orders", label: "سجل الطلبات", icon: "history", allowed: true },
  { id: "delivery", label: "التوصيل", icon: "truck", allowed: true },
  { id: "debt", label: "الديون", icon: "wallet", allowed: true, readOnly: true },
  { id: "guide", label: "الدليل", icon: "book", allowed: true },
];

const MANAGER_NAV: SidebarNavItem[] = [
  { id: "pos", label: "نقاط البيع", icon: "calculator", allowed: true },
  { id: "shift", label: "الوردية", icon: "clock", allowed: true },
  { id: "orders", label: "سجل الطلبات", icon: "history", allowed: true },
  { id: "delivery", label: "التوصيل", icon: "truck", allowed: true },
  { id: "debt", label: "الديون", icon: "wallet", allowed: true },
  { id: "customers", label: "العملاء", icon: "users", allowed: true },
  { id: "menu", label: "القائمة", icon: "book-open", allowed: true },
  { id: "kds", label: "المطبخ", icon: "package", allowed: true },
  { id: "ai-onboarding", label: "إعداد القائمة AI", icon: "scan-line", allowed: true },
  { id: "inventory", label: "المخزون", icon: "package", allowed: true },
  { id: "stockroom", label: "مخزون المنتجات", icon: "package", allowed: true },
  { id: "marketplace", label: "متجر الموردين", icon: "shopping-cart", allowed: true },
  { id: "reports", label: "التقارير", icon: "bar-chart-3", allowed: true },
  { id: "staff", label: "الموظفين", icon: "users-round", allowed: true },
  { id: "schedule", label: "جدول الدوام", icon: "calendar", allowed: true },
  { id: "payroll", label: "الرواتب", icon: "wallet", allowed: true },
  { id: "ai", label: "المساعد الذكي", icon: "bot", allowed: true },
  { id: "jobs", label: "شواغر", icon: "briefcase", allowed: true },
  { id: "guide", label: "الدليل", icon: "book", allowed: true },
  { id: "settings", label: "الإعدادات", icon: "settings", allowed: true },
];

const ACCOUNTANT_NAV: SidebarNavItem[] = [
  { id: "pos", label: "نقاط البيع", icon: "calculator", allowed: true },
  { id: "shift", label: "الوردية", icon: "clock", allowed: true },
  { id: "orders", label: "سجل الطلبات", icon: "history", allowed: true },
  { id: "reports", label: "التقارير", icon: "bar-chart-3", allowed: true },
  { id: "finance", label: "المالية", icon: "wallet", allowed: true },
  { id: "guide", label: "الدليل", icon: "book", allowed: true },
];

const OWNER_NAV: SidebarNavItem[] = [
  { id: "dashboard", label: "لوحة التحكم", icon: "layout-dashboard", allowed: true },
  { id: "pos", label: "نقاط البيع", icon: "calculator", allowed: true },
  { id: "shift", label: "الوردية", icon: "clock", allowed: true },
  { id: "orders", label: "سجل الطلبات", icon: "history", allowed: true },
  { id: "delivery", label: "التوصيل", icon: "truck", allowed: true },
  { id: "debt", label: "الديون", icon: "wallet", allowed: true },
  { id: "customers", label: "العملاء", icon: "users", allowed: true },
  { id: "menu", label: "القائمة", icon: "book-open", allowed: true },
  { id: "kds", label: "المطبخ", icon: "package", allowed: true },
  { id: "inventory", label: "المخزون", icon: "package", allowed: true },
  { id: "stockroom", label: "مخزون المنتجات", icon: "package", allowed: true },
  { id: "marketplace", label: "متجر الموردين", icon: "shopping-cart", allowed: true },
  { id: "reports", label: "التقارير", icon: "bar-chart-3", allowed: true },
  { id: "staff", label: "الموظفين", icon: "users-round", allowed: true },
  { id: "schedule", label: "جدول الدوام", icon: "calendar", allowed: true },
  { id: "branches", label: "الفروع", icon: "building-2", allowed: true },
  { id: "finance", label: "المالية", icon: "wallet", allowed: true },
  { id: "payroll", label: "الرواتب", icon: "wallet", allowed: true },
  { id: "loyalty", label: "برنامج الولاء", icon: "award", allowed: true },
  { id: "ai", label: "المساعد الذكي", icon: "bot", allowed: true },
  { id: "ai-onboarding", label: "إعداد القائمة AI", icon: "scan-line", allowed: true },
  { id: "jobs", label: "شواغر", icon: "briefcase", allowed: true },
  { id: "guide", label: "الدليل", icon: "book", allowed: true },
  { id: "settings", label: "الإعدادات", icon: "settings", allowed: true },
];

const KITCHEN_NAV: SidebarNavItem[] = [
  { id: "kds", label: "المطبخ", icon: "calculator", allowed: true },
  { id: "shift", label: "الوردية", icon: "clock", allowed: true },
  { id: "guide", label: "الدليل", icon: "book", allowed: true },
];

/**
 * The pages the owner can open or close per role (Settings > الصلاحيات), and the feature each belongs to.
 * Must match `Feature::key` in `src-tauri/src/role_access.rs`.
 */
export const PAGE_FEATURE: Record<string, string> = {
  reports: "reports",
  ai: "reports",
  finance: "finance",
  inventory: "inventory",
  stockroom: "inventory",
  menu: "menu",
  "ai-onboarding": "menu",
  staff: "staff",
  schedule: "staff",
  settings: "settings",
};

/** What the owner's choices do to a role's normal pages: close the ones taken away, open the ones given. */
export function applyAccess(nav: SidebarNavItem[], features: Record<string, boolean> | null | undefined): SidebarNavItem[] {
  if (!features) return nav;
  const kept = nav.filter((n) => {
    const f = PAGE_FEATURE[n.id];
    return f === undefined || features[f] !== false;
  });
  const have = new Set(kept.map((n) => n.id));
  const added = OWNER_NAV.filter((n) => {
    const f = PAGE_FEATURE[n.id];
    return f !== undefined && features[f] === true && !have.has(n.id);
  });
  if (added.length === 0) return kept;
  const guideAt = kept.findIndex((n) => n.id === "guide");
  const at = guideAt === -1 ? kept.length : guideAt;
  return [...kept.slice(0, at), ...added, ...kept.slice(at)];
}

export function getNavForRole(role: UserRole | undefined, features?: Record<string, boolean> | null): SidebarNavItem[] {
  const nav = (() => {
    switch (role) {
      case "OWNER":
        return OWNER_NAV;
      case "ACCOUNTANT":
        return ACCOUNTANT_NAV;
      case "MANAGER":
      case "ADMIN":
        return MANAGER_NAV;
      case "KITCHEN":
        return KITCHEN_NAV;
      default:
        return CASHIER_NAV;
    }
  })();
  const shown = role === "OWNER" ? nav : applyAccess(nav, features);
  if (import.meta.env.DEV) {
    return [...shown, { id: "debug", label: "التشخيص", icon: "terminal", allowed: true }];
  }
  return shown;
}

export function getMaxDiscountPercent(role: UserRole | undefined): number {
  switch (role) {
    case "OWNER":
      return 100;
    case "MANAGER":
    case "ADMIN":
      return 50;
    default:
      return 10;
  }
}

export function canVoidAnyOrder(role: UserRole | undefined): boolean {
  return role === "MANAGER" || role === "ADMIN" || role === "OWNER";
}

export function canAccessInventory(role: UserRole | undefined): boolean {
  return role === "MANAGER" || role === "ADMIN" || role === "OWNER";
}

export function canAccessReports(role: UserRole | undefined): boolean {
  return role === "MANAGER" || role === "ADMIN" || role === "OWNER" || role === "ACCOUNTANT";
}

export function canAccessStaff(role: UserRole | undefined): boolean {
  return role === "MANAGER" || role === "ADMIN" || role === "OWNER";
}

// HR_AND_GENERALIZATION_PLAN.md Part A -- same rank as canAccessStaff:
// scheduling staff is the same class of back-office decision as
// hiring/editing them (matches ManageRoster's Manager+ rank server-side).
export function canAccessRoster(role: UserRole | undefined): boolean {
  return role === "MANAGER" || role === "ADMIN" || role === "OWNER";
}

export function canAccessFinance(role: UserRole | undefined): boolean {
  return role === "OWNER" || role === "ACCOUNTANT";
}

export function canAccessBranches(role: UserRole | undefined): boolean {
  return role === "OWNER";
}

export function canAccessSettings(role: UserRole | undefined): boolean {
  return role === "MANAGER" || role === "ADMIN" || role === "OWNER";
}

export function canManageMenu(role: UserRole | undefined): boolean {
  return role === "MANAGER" || role === "ADMIN" || role === "OWNER";
}

// Mirrors force_close_shift_v3's Manager+ rank check (security.rs):
// MANAGER, OWNER and the top PLATFORM role.
export function canForceCloseShift(role: UserRole | "PLATFORM" | string | undefined): boolean {
  return role === "MANAGER" || role === "ADMIN" || role === "OWNER" || role === "PLATFORM";
}
