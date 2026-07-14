import { create } from "zustand";

export interface HappyHourRule {
  id: string;
  menuItemId: string;
  discountPercent: number;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  is_active: number;
}

interface HappyHourState {
  rules: HappyHourRule[];
  setRules: (rules: HappyHourRule[]) => void;
  addRule: (rule: HappyHourRule) => void;
  removeRule: (id: string) => void;
}

export const useHappyHourStore = create<HappyHourState>((set) => ({
  rules: [],
  setRules: (rules) => set({ rules }),
  addRule: (rule) => set((s) => ({ rules: [...s.rules, rule] })),
  removeRule: (id) => set((s) => ({ rules: s.rules.filter((r) => r.id !== id) })),
}));

export function getActiveHappyHourDiscount(
  menuItemId: string,
  rules: HappyHourRule[]
): number {
  const now = new Date();
  const day = now.getDay();
  const time = now.toTimeString().slice(0, 5);

  for (const rule of rules) {
    if (rule.menuItemId !== menuItemId) continue;
    if (rule.dayOfWeek !== day) continue;
    if (!rule.is_active) continue;
    if (time < rule.startTime || time > rule.endTime) continue;
    return rule.discountPercent;
  }

  return 0;
}
