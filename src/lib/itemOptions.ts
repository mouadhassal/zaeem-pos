// Item options ("without onion", "extra cheese +2000"): the shapes the menu
// screen saves, and the pure helpers the till uses to turn a cashier's picks
// into order modifiers. The server re-prices every modifier by name against
// the catalogue (ops.rs `price_modifiers`), so nothing here is trusted for
// money -- this only drives what the cashier sees.

export interface OptionChoice {
  id: string;
  name: string;
  price_cents: number;
  sort_order: number;
}

export interface OptionTarget {
  target_type: "ITEM" | "CATEGORY";
  target_id: string;
}

export interface OptionGroup {
  id: string;
  name: string;
  selection: "MULTI" | "SINGLE";
  required: boolean;
  sort_order: number;
  is_active: boolean;
  choices: OptionChoice[];
  targets: OptionTarget[];
}

export interface Modifier {
  name: string;
  priceCents: number;
}

/** What the owner typed plus which button they pressed, as a choice name. */
export function quickChoice(kind: "without" | "extra" | "plain", text: string): { name: string } {
  const t = text.trim();
  if (kind === "without") return { name: `بدون ${t}` };
  if (kind === "extra") return { name: `زيادة ${t}` };
  return { name: t };
}

/** Active groups that apply to this menu item, directly or through its category. */
export function groupsForItem(groups: readonly OptionGroup[], itemId: string, categoryId: string | null | undefined): OptionGroup[] {
  return groups
    .filter((g) => g.is_active && g.choices.length > 0)
    .filter((g) => g.targets.some((t) => (t.target_type === "ITEM" && t.target_id === itemId) || (t.target_type === "CATEGORY" && !!categoryId && t.target_id === categoryId)))
    .sort((a, b) => a.sort_order - b.sort_order);
}

/** Group id -> chosen choice ids. */
export type Selection = Record<string, string[]>;

/** Toggles a choice, keeping a SINGLE group to one pick. */
export function toggleChoice(group: OptionGroup, selection: Selection, choiceId: string): Selection {
  const current = selection[group.id] ?? [];
  const has = current.includes(choiceId);
  let next: string[];
  if (group.selection === "SINGLE") next = has ? [] : [choiceId];
  else next = has ? current.filter((c) => c !== choiceId) : [...current, choiceId];
  return { ...selection, [group.id]: next };
}

/** Names of required groups with nothing picked yet. */
export function missingRequired(groups: readonly OptionGroup[], selection: Selection): string[] {
  return groups.filter((g) => g.required && (selection[g.id] ?? []).length === 0).map((g) => g.name);
}

/** The picks as order modifiers, in the group and choice order the owner set. */
export function selectionToModifiers(groups: readonly OptionGroup[], selection: Selection): Modifier[] {
  const out: Modifier[] = [];
  for (const g of groups) {
    const picked = new Set(selection[g.id] ?? []);
    for (const c of g.choices) {
      if (picked.has(c.id)) out.push({ name: c.name, priceCents: c.price_cents });
    }
  }
  return out;
}

/** Two cart lines are the same line only if item, options, note and gift status all match. */
export function lineKey(line: { menuItemId: string; modifiers: readonly Modifier[]; notes: string; comped?: boolean }): string {
  const mods = line.modifiers.map((m) => m.name).sort().join("|");
  return `${line.menuItemId}::${mods}::${line.notes.trim()}::${line.comped ? "gift" : ""}`;
}

/** Rebuilds a picker selection from modifiers already on a cart line (matched by name). */
export function selectionFromModifiers(groups: readonly OptionGroup[], modifiers: readonly { name: string }[]): Selection {
  const names = new Set(modifiers.map((m) => m.name));
  const out: Selection = {};
  for (const g of groups) {
    const ids = g.choices.filter((c) => names.has(c.name)).map((c) => c.id);
    if (ids.length) out[g.id] = g.selection === "SINGLE" ? ids.slice(0, 1) : ids;
  }
  return out;
}

/** Modifiers on a line that belong to no current option group (kept as-is when the line is edited). */
export function customModifiers(groups: readonly OptionGroup[], modifiers: readonly Modifier[]): Modifier[] {
  const known = new Set(groups.flatMap((g) => g.choices.map((c) => c.name)));
  return modifiers.filter((m) => !known.has(m.name));
}
