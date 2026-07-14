export type LicenseStatus =
  | "active"
  | "expiring"
  | "grace"
  | "expired";

export interface LicenseResult {
  status: LicenseStatus;
  daysRemaining: number;
}

export async function validateLicense(_jwt?: string): Promise<LicenseResult> {
  return { status: "active", daysRemaining: 365 };
}
