// Inlined from packages/types/src/license.ts -- this repo has its own git
// history/remote separate from the monorepo root (see AGENTS.md), so it
// can't resolve a `workspace:*` dependency when checked out standalone
// (e.g. in GitHub Actions).
type LicenseStatus = "active" | "expired" | "suspended" | "trial";

export function getLicenseStatusColor(status: LicenseStatus): string {
  switch (status) {
    case "active":
      return "#12A150";
    case "trial":
      return "#E8A317";
    case "expired":
      return "#E03B3B";
    case "suspended":
      return "#667085";
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
