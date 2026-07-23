import type { UserRole } from "../db/types";

export type OrderType = "dine-in" | "takeaway" | "delivery" | "online";

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
  { id: "debt", label: "الديون", icon: "wallet", allowed: true, readOnly: true },
];

const MANAGER_NAV: SidebarNavItem[] = [
  { id: "pos", label: "نقاط البيع", icon: "calculator", allowed: true },
  { id: "shift", label: "الوردية", icon: "clock", allowed: true },
  { id: "debt", label: "الديون", icon: "wallet", allowed: true },
  { id: "customers", label: "العملاء", icon: "users", allowed: true },
  { id: "menu", label: "القائمة", icon: "book-open", allowed: true },
  { id: "kds", label: "المطبخ", icon: "package", allowed: true },
  { id: "ai-onboarding", label: "إعداد القائمة AI", icon: "scan-line", allowed: true },
  { id: "inventory", label: "المخزون", icon: "package", allowed: true },
  { id: "delivery", label: "التوصيل", icon: "truck", allowed: true },
  { id: "reports", label: "التقارير", icon: "bar-chart-3", allowed: true },
  { id: "staff", label: "الموظفين", icon: "users-round", allowed: true },
  { id: "settings", label: "الإعدادات", icon: "settings", allowed: true },
];

const ACCOUNTANT_NAV: SidebarNavItem[] = [
  { id: "pos", label: "نقاط البيع", icon: "calculator", allowed: true },
  { id: "shift", label: "الوردية", icon: "clock", allowed: true },
  { id: "reports", label: "التقارير", icon: "bar-chart-3", allowed: true },
  { id: "finance", label: "المالية", icon: "wallet", allowed: true },
];

const OWNER_NAV: SidebarNavItem[] = [
  { id: "pos", label: "نقاط البيع", icon: "calculator", allowed: true },
  { id: "shift", label: "الوردية", icon: "clock", allowed: true },
  { id: "debt", label: "الديون", icon: "wallet", allowed: true },
  { id: "customers", label: "العملاء", icon: "users", allowed: true },
  { id: "menu", label: "القائمة", icon: "book-open", allowed: true },
  { id: "kds", label: "المطبخ", icon: "package", allowed: true },
  { id: "inventory", label: "المخزون", icon: "package", allowed: true },
  { id: "reports", label: "التقارير", icon: "bar-chart-3", allowed: true },
  { id: "staff", label: "الموظفين", icon: "users-round", allowed: true },
  { id: "delivery", label: "التوصيل", icon: "truck", allowed: true },
  { id: "branches", label: "الفروع", icon: "building-2", allowed: true },
  { id: "finance", label: "المالية", icon: "wallet", allowed: true },
  { id: "loyalty", label: "برنامج الولاء", icon: "award", allowed: true },
  { id: "ai", label: "المساعد الذكي", icon: "bot", allowed: true },
  { id: "ai-onboarding", label: "إعداد القائمة AI", icon: "scan-line", allowed: true },
  { id: "settings", label: "الإعدادات", icon: "settings", allowed: true },
];

const KITCHEN_NAV: SidebarNavItem[] = [
  { id: "kds", label: "المطبخ", icon: "calculator", allowed: true },
  { id: "shift", label: "الوردية", icon: "clock", allowed: true },
];

export function getNavForRole(role: UserRole | undefined): SidebarNavItem[] {
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
  if (import.meta.env.DEV) {
    return [...nav, { id: "debug", label: "التشخيص", icon: "terminal", allowed: true }];
  }
  return nav;
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

export function canForceCloseShift(role: UserRole | undefined): boolean {
  return role === "MANAGER" || role === "ADMIN" || role === "OWNER";
}
