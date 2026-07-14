import type { LicenseStatus } from "@zaeem/types";

export function getLicenseStatusColor(status: LicenseStatus): string {
  switch (status) {
    case "active":
      return "#10b981";
    case "trial":
      return "#f59e0b";
    case "expired":
      return "#ef4444";
    case "suspended":
      return "#6b7280";
  }
}

export function formatCurrency(
  amountCents: number,
  currency: string = "SAR"
): string {
  const amount = amountCents / 100;
  return new Intl.NumberFormat("ar-SA", {
    style: "currency",
    currency,
  }).format(amount);
}
