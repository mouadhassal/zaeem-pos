import { useMemo } from "react";
import { useAuthStore } from "../stores/authStore";
import {
  getNavForRole,
  getMaxDiscountPercent,
  canVoidAnyOrder,
  canAccessInventory,
  canAccessReports,
  canAccessStaff,
  canAccessFinance,
  canAccessBranches,
  canAccessSettings,
  canManageMenu,
  canForceCloseShift,
} from "../lib/permissions";

export function usePermissions() {
  const role = useAuthStore((s) => s.user?.role);

  return useMemo(
    () => ({
      role,
      navItems: getNavForRole(role),
      maxDiscountPercent: getMaxDiscountPercent(role),
      canVoidAnyOrder: canVoidAnyOrder(role),
      canAccessInventory: canAccessInventory(role),
      canAccessReports: canAccessReports(role),
      canAccessStaff: canAccessStaff(role),
      canAccessFinance: canAccessFinance(role),
      canAccessBranches: canAccessBranches(role),
      canAccessSettings: canAccessSettings(role),
      canManageMenu: canManageMenu(role),
      canForceCloseShift: canForceCloseShift(role),
    }),
    [role]
  );
}
