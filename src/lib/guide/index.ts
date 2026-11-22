import type { GuideChapter, GuideRole, GuideTask } from "./types";
import type { Terms } from "../terms";
import { START_CHAPTERS } from "./chapters/start";
import { TILL_CHAPTERS } from "./chapters/till";
import { DELIVERY_CHAPTERS } from "./chapters/delivery";
import { BACK_CHAPTERS } from "./chapters/back";
import { ADMIN_CHAPTERS } from "./chapters/admin";
import { HELP_CHAPTERS } from "./chapters/help";

export type { GuideChapter, GuideRole, GuideTask } from "./types";

/** Reading order: first steps, the till, delivery and kitchen, back office, owner and settings, then help. */
export const ALL_CHAPTERS: GuideChapter[] = [
  ...START_CHAPTERS,
  ...TILL_CHAPTERS,
  ...DELIVERY_CHAPTERS,
  ...BACK_CHAPTERS,
  ...ADMIN_CHAPTERS,
  ...HELP_CHAPTERS,
];

/** Maps the signed-in user's role string to the roles the guide is written for. */
export function guideRoleOf(role: string | undefined | null): GuideRole {
  switch ((role ?? "").toUpperCase()) {
    case "OWNER":
    case "PLATFORM":
      return "OWNER";
    case "MANAGER":
    case "ADMIN":
      return "MANAGER";
    case "KITCHEN":
      return "KITCHEN";
    case "ACCOUNTANT":
      return "ACCOUNTANT";
    default:
      return "CASHIER";
  }
}

/**
 * The chapters a person should see. `role` null = everything (the "all
 * guides" view). POS Lite never sees what it doesn't have: a Full-only
 * chapter, or a Full-only task inside a shared chapter, is dropped.
 */
export function chaptersFor(role: GuideRole | null, posLite: boolean, terms?: Terms): GuideChapter[] {
  const chapters = ALL_CHAPTERS
    .filter((c) => (role === null || c.roles.includes(role)) && !(posLite && c.fullOnly))
    .map((c) => (posLite ? { ...c, tasks: c.tasks.filter((t) => !t.fullOnly) } : c))
    .filter((c) => c.tasks.length > 0);
  return terms ? localizeChapters(chapters, terms) : chapters;
}

/**
 * The guide is written in the restaurant's words. The names of pages and tabs it quotes in «» are swapped for this
 * business's own (a shop's «المنتجات», a supplier's «قائمة الأسعار» and «العملاء التجار»), so a step never points at a
 * page that is not on the sidebar.
 */
export function localizeText(text: string, t: Terms): string {
  return text
    .replace(/«القائمة(?=[ »])/g, `«${t.menu}`)
    .replace(/«إعداد القائمة AI»/g, `«${t.menuSetupAi}»`)
    .replace(/«العملاء»/g, `«${t.customersNav}»`)
    .replace(/«سجل الطلبات(?=[ »])/g, `«${t.ordersNav}`)
    .replace(/«الأصناف»/g, `«${t.theItems}»`)
    .replace(/«أفضل الأصناف»/g, `«${t.topItems}»`)
    .replace(/«هامش الأصناف»/g, `«${t.itemMargins}»`)
    .replace(/عدد الأصناف في كل صف/g, `عدد ${t.items} في كل صف`);
}

export function localizeChapters(chapters: GuideChapter[], t: Terms): GuideChapter[] {
  const fix = (list?: string[]) => list?.map((x) => localizeText(x, t));
  return chapters.map((c) => ({
    ...c,
    title: localizeText(c.title, t),
    blurb: localizeText(c.blurb, t),
    tasks: c.tasks.map((k) => {
      const out = { ...k, title: localizeText(k.title, t) } as GuideTask;
      if (k.when) out.when = localizeText(k.when, t);
      for (const key of ["steps", "points", "tips", "warnings"] as const) {
        const v = fix(k[key]);
        if (v) out[key] = v;
      }
      return out;
    }),
  }));
}

// Arabic search: ignore diacritics and the letters people type loosely.
export function normalizeArabic(text: string): string {
  return text
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .toLowerCase();
}

function taskText(task: GuideTask): string {
  return normalizeArabic(
    [task.title, task.when, ...(task.steps ?? []), ...(task.points ?? []), ...(task.tips ?? []), ...(task.warnings ?? [])]
      .filter(Boolean)
      .join(" \n "),
  );
}

/** Keeps only the tasks that contain every word typed, and only the chapters left with a task. */
export function searchChapters(chapters: GuideChapter[], query: string): GuideChapter[] {
  const words = normalizeArabic(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return chapters;
  return chapters
    .map((c) => ({ ...c, tasks: c.tasks.filter((t) => { const text = taskText(t); return words.every((w) => text.includes(w)); }) }))
    .filter((c) => c.tasks.length > 0);
}
