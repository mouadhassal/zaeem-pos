export interface TaxConfig {
  mode: "inclusive" | "exclusive";
  taxRateCents: number;
  secondaryTaxRateCents: number;
  serviceChargeRateCents: number;
}

export interface TaxResult {
  subtotalCents: number;
  taxCents: number;
  secondaryTaxCents: number;
  serviceChargeCents: number;
  totalCents: number;
}

export function calculateTax(
  itemTotalCents: number,
  discountCents: number,
  config: TaxConfig
): TaxResult {
  const effectiveTotal = Math.max(0, itemTotalCents - discountCents);

  if (config.mode === "inclusive") {
    const divisor = 10000 + config.taxRateCents;
    const taxCents = Math.round((effectiveTotal * config.taxRateCents) / divisor);
    const subtotalCents = effectiveTotal - taxCents;

    const secondaryTaxCents = config.secondaryTaxRateCents > 0
      ? Math.round((subtotalCents * config.secondaryTaxRateCents) / 10000)
      : 0;

    const serviceChargeCents = config.serviceChargeRateCents > 0
      ? Math.round((subtotalCents * config.serviceChargeRateCents) / 10000)
      : 0;

    const totalCents = subtotalCents + taxCents + secondaryTaxCents + serviceChargeCents;

    return { subtotalCents, taxCents, secondaryTaxCents, serviceChargeCents, totalCents };
  }

  const subtotalCents = effectiveTotal;
  const taxCents = Math.round((effectiveTotal * config.taxRateCents) / 10000);
  const secondaryTaxCents = config.secondaryTaxRateCents > 0
    ? Math.round((effectiveTotal * config.secondaryTaxRateCents) / 10000)
    : 0;
  const serviceChargeCents = config.serviceChargeRateCents > 0
    ? Math.round((effectiveTotal * config.serviceChargeRateCents) / 10000)
    : 0;

  const totalCents = subtotalCents + taxCents + secondaryTaxCents + serviceChargeCents;

  return { subtotalCents, taxCents, secondaryTaxCents, serviceChargeCents, totalCents };
}

export function calculateComboSavings(
  regularTotalCents: number,
  bundlePriceCents: number
): number {
  return Math.max(0, regularTotalCents - bundlePriceCents);
}

export async function getDefaultTaxConfig(): Promise<TaxConfig> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { useAuthStore } = await import("../stores/authStore");
    const token = useAuthStore.getState().token;
    const config = await invoke<{ tax_mode: string; tax_rate_cents: number; secondary_tax_rate_cents: number; service_charge_rate_cents: number }>(
      "get_chain_config_v3", { sessionToken: token }
    );

    if (config) {
      return {
        mode: config.tax_mode as "inclusive" | "exclusive",
        taxRateCents: config.tax_rate_cents,
        secondaryTaxRateCents: config.secondary_tax_rate_cents,
        serviceChargeRateCents: config.service_charge_rate_cents,
      };
    }
  } catch {
    // fall through to defaults
  }

  return {
    mode: "exclusive",
    taxRateCents: 1500,
    secondaryTaxRateCents: 0,
    serviceChargeRateCents: 0,
  };
}
