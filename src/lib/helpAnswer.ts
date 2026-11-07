/**
 * The help chat's memory: the in-app guide. A question is matched against every task of the guide the
 * person is allowed to see; the best few become the "excerpts" the AI answers from (it is told to say so
 * when they do not cover the question), and the same excerpts are the answer when there is no internet.
 * No DOM, no invoke: unit-tested.
 */
import { chaptersFor, guideRoleOf, normalizeArabic, type GuideChapter, type GuideTask } from "./guide";

export interface GuideMatch {
  chapter: GuideChapter;
  task: GuideTask;
  score: number;
}

/** Words too common to tell tasks apart (Arabic question words and glue). */
const STOP = new Set(["كيف", "ماذا", "ماذا", "هل", "اين", "اي", "ما", "هو", "هي", "في", "من", "الى", "على", "عن", "لا", "انا", "اريد", "ابي", "بدي", "ممكن", "لو", "سمحت", "او", "ان", "هذا", "هذه", "كم", "مع"]);

/** Light stemming: drop the leading "ال" so "الصنف" matches "صنف". */
function stem(w: string): string {
  return w.length > 3 && w.startsWith("ال") ? w.slice(2) : w;
}

function words(text: string): string[] {
  return normalizeArabic(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

function taskParts(task: GuideTask): { title: string; body: string } {
  return {
    title: normalizeArabic(task.title),
    body: normalizeArabic([task.when, ...(task.steps ?? []), ...(task.points ?? []), ...(task.tips ?? []), ...(task.warnings ?? [])].filter(Boolean).join(" \n ")),
  };
}

/** The best matching tasks for a question, best first. A word in the title counts more than one in the body. */
export function matchGuide(question: string, chapters: readonly GuideChapter[], limit = 5): GuideMatch[] {
  const qs = words(question);
  if (qs.length === 0) return [];
  const out: GuideMatch[] = [];
  for (const chapter of chapters) {
    const chapterTitle = normalizeArabic(chapter.title + " " + chapter.blurb);
    for (const task of chapter.tasks) {
      const { title, body } = taskParts(task);
      let score = 0;
      for (const w of qs) {
        if (title.includes(w)) score += 3;
        else if (body.includes(w)) score += 1;
        if (chapterTitle.includes(w)) score += 0.5;
      }
      // Most of the question must be found, or it is a coincidence of one common word.
      const found = qs.filter((w) => title.includes(w) || body.includes(w) || chapterTitle.includes(w)).length;
      if (score > 0 && found / qs.length >= 0.6) out.push({ chapter, task, score });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

function taskText(chapter: GuideChapter, task: GuideTask): string {
  const lines = [`## ${task.title} (فصل: ${chapter.title}${chapter.page ? `، شاشة: ${chapter.page}` : ""})`];
  if (task.when) lines.push(`متى: ${task.when}`);
  (task.steps ?? []).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  for (const p of task.points ?? []) lines.push(`- ${p}`);
  for (const t of task.tips ?? []) lines.push(`نصيحة: ${t}`);
  for (const w of task.warnings ?? []) lines.push(`تنبيه: ${w}`);
  return lines.join("\n");
}

/** The excerpts sent along with the question, capped so the request stays small. */
export function excerptsFor(matches: readonly GuideMatch[], maxChars = 9000): string {
  let out = "";
  for (const m of matches) {
    const block = taskText(m.chapter, m.task);
    if (out.length + block.length + 2 > maxChars) break;
    out += (out ? "\n\n" : "") + block;
  }
  return out;
}

/** The matches written as an answer, for when the AI cannot be reached: the guide itself, not a guess. */
export function offlineAnswer(matches: readonly GuideMatch[]): string {
  if (matches.length === 0) {
    return "لم أجد في دليل النظام ما يخص سؤالك. جرّب كلمات أبسط (مثلاً: «إضافة صنف»، «إغلاق الوردية»)، أو افتح الدليل من الشريط الجانبي وتصفح فصوله.";
  }
  // Only the matches that are nearly as good as the best one, written for a person (bold title, not a markdown heading).
  const top = matches[0]!.score;
  return matches
    .filter((m, i) => i < 2 && m.score >= top * 0.6)
    .map((m) => taskText(m.chapter, m.task).replace(/^## (.*)$/m, "**$1**"))
    .join("\n\n");
}

/** The questions people ask most, per role, as tap-to-ask chips. */
export function suggestionsFor(role: string | undefined | null): string[] {
  switch (guideRoleOf(role)) {
    case "CASHIER":
      return ["كيف أفتح الوردية؟", "كيف ألغي طلباً كاملاً؟", "كيف أطبع فاتورة قديمة؟", "كيف أضيف خصماً؟"];
    case "KITCHEN":
      return ["كيف أغير حالة الطلب؟", "أين تظهر الطلبات الجديدة؟"];
    default:
      return ["كيف أضيف صنفاً للقائمة؟", "كيف أستورد المنتجات من Excel؟", "كيف أحسب رواتب الموظفين؟", "كيف أوصل طابعة المطبخ؟", "ما الفرق بين أنواع الأرباح؟"];
  }
}

/** The chapters this person can see, so the help never explains a screen they do not have. */
export function visibleChapters(role: string | undefined | null, posLite: boolean): GuideChapter[] {
  return chaptersFor(guideRoleOf(role), posLite);
}
