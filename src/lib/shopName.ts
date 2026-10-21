/**
 * The database's default shop name from the Zaeem days. A till that never
 * set its name (setup done before the wizard asked, or skipped) printed
 * "Zaeem POS" on every customer receipt.
 */
export const LEGACY_DEFAULT_SHOP_NAME = "Zaeem POS";

/** The name to print at the top of receipts and slips: the shop's own name, else its branch name. */
export function printableShopName(chainName: string | null | undefined, branchName?: string | null): string {
  const name = (chainName ?? "").trim();
  if (name && name !== LEGACY_DEFAULT_SHOP_NAME) return name;
  return (branchName ?? "").trim();
}
