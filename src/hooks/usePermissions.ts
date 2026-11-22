import { useMemo } from "react";
import { useAuthStore } from "../stores/authStore";
import { useAccessStore } from "../stores/accessStore";
import { useBackOfficeStore } from "../stores/backOfficeStore";
import {
  getNavForRole,
  applyBackOfficeAccess,
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
  const features = useAccessStore((s) => s.features);
  const backOffice = useBackOfficeStore((s) => s.access);

  return useMemo(
    () => ({
      role,
      navItems: applyBackOfficeAccess(getNavForRole(role, features), backOffice),
      /** What the owner's table says about the signed-in person, by feature key (null = not asked yet). */
      features,
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
    [role, features, backOffice]
  );
}
