// The AI assistant page's pure helpers: the comparison windows it sends along
// with a question, the chat history it replays, and a tiny safe renderer for
// the answer's "- bullet" and **bold** text. No DOM, no invoke -- unit-tested.

export type Range = "today" | "week" | "month";

export interface PeriodWindow {
  label: string;
  start_iso: string;
  end_iso: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

function startOfDay(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

const iso = (d: Date) => d.toISOString();
const endBefore = (d: Date) => new Date(d.getTime() - 1);

/** Minutes EAST of UTC (Damascus in winter = 120); JS reports the opposite sign. */
export function tzOffsetMinutes(now: Date = new Date()): number {
  return -now.getTimezoneOffset();
}

/**
 * The windows the till sums up for every question, in the user's LOCAL days,
 * so "yesterday", "last week" and "this month" mean what the owner means.
 * The assistant picks whichever one the question is about.
 */
export function buildPeriods(now: Date = new Date()): PeriodWindow[] {
  const today = startOfDay(now);
  const win = (label: string, from: Date, to: Date): PeriodWindow => ({ label, start_iso: iso(from), end_iso: iso(to) });
  return [
    win("today", today, now),
    win("yesterday", addDays(today, -1), endBefore(today)),
    win("same_weekday_last_week", addDays(today, -7), endBefore(addDays(today, -6))),
    win("last_7_days", addDays(today, -6), now),
    win("previous_7_days", addDays(today, -13), endBefore(addDays(today, -6))),
    win("this_month", new Date(today.getFullYear(), today.getMonth(), 1), now),
    win("last_30_days", addDays(today, -29), now),
    win("previous_30_days", addDays(today, -59), endBefore(addDays(today, -29))),
  ];
}

/** The detailed-data window for the range chips (today / 7 days / 30 days). */
export function rangeToIso(range: Range, now: Date = new Date()): { startIso: string; endIso: string } {
  const today = startOfDay(now);
  const start = range === "today" ? today : addDays(today, range === "week" ? -6 : -29);
  return { startIso: iso(start), endIso: iso(now) };
}

const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** "2026-11-01 (الأحد) 14:30" -- tells the model what "today" is. */
export function nowLocalLabel(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} (${WEEKDAYS[now.getDay()]}) ${p(now.getHours())}:${p(now.getMinutes())}`;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** a failed request: shown as an error with a retry button, never replayed as history */
  error?: boolean;
  /** the welcome bubble: never sent as history */
  intro?: boolean;
}

export const MAX_HISTORY = 6;

/**
 * The last few real exchanges, oldest first, without errors or the welcome
 * text. A question whose answer failed is left out too, so a retry or a later
 * question is not preceded by a dangling, unanswered turn.
 */
export function toHistory(messages: ChatMessage[]): ChatTurn[] {
  return messages
    .filter((m, i, all) => !m.error && !m.intro && m.content.trim() !== "" && !(m.role === "user" && all[i + 1]?.error))
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, text: m.content }));
}

/** An invoke() failure as one clean line (the Rust side already sends Arabic). */
export function errorText(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).replace(/^Error:\s*/, "").trim();
  return raw || "تعذّر الحصول على جواب من المساعد الذكي، حاول مجدداً";
}

// ---- answer rendering ----

export interface Segment {
  text: string;
  bold: boolean;
}

export type Block =
  | { type: "p"; segments: Segment[] }
  | { type: "ul"; items: Segment[][] }
  | { type: "next"; segments: Segment[] };

/** Splits "a **b** c" into plain and bold runs. An unmatched ** stays literal. */
export function inlineSegments(line: string): Segment[] {
  const parts = line.split("**");
  if (parts.length < 3 || parts.length % 2 === 0) return [{ text: line, bold: false }];
  const segs = parts.map((text, i) => ({ text, bold: i % 2 === 1 })).filter((s) => s.text !== "");
  return segs.length ? segs : [{ text: line, bold: false }];
}

const BULLET = /^\s*(?:[-•*]|\d+[.)])\s+(.*)$/;
const NEXT_STEP = /^\s*(?:\*\*)?الخطوة التالية:?(?:\*\*)?:?\s*/;

/** Answer text -> paragraphs, bullet lists and the "next step" callout. Plain data, rendered by React (no HTML injection). */
export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = [];
  let list: Segment[][] | null = null;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      list = null;
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      if (!list) {
        list = [];
        blocks.push({ type: "ul", items: list });
      }
      list.push(inlineSegments(bullet[1]));
      continue;
    }
    list = null;
    if (NEXT_STEP.test(line)) {
      blocks.push({ type: "next", segments: inlineSegments(line.replace(NEXT_STEP, "")) });
    } else {
      blocks.push({ type: "p", segments: inlineSegments(line.trim()) });
    }
  }
  return blocks;
}

export const FOLLOW_UPS = [
  { label: "قارن بالأسبوع الماضي", question: "قارن هذا بالأسبوع الماضي" },
  { label: "ما السبب؟", question: "ما سبب ذلك برأيك بناءً على البيانات؟" },
  { label: "ماذا أفعل؟", question: "ماذا تنصحني أن أفعل بناءً على ذلك؟" },
];

export const QUICK_QUESTIONS = [
  { label: "مبيعات اليوم", question: "كم بعنا اليوم وكم عدد الطلبات، وكيف يقارن بأمس؟" },
  { label: "ساعات الذروة", question: "ما هي ساعات الذروة عندنا وكم نبيع في كل منها؟" },
  { label: "أفضل الأصناف", question: "ما هي أفضل الأصناف مبيعاً وأكثرها ربحاً في هذه الفترة؟" },
  { label: "الأصناف البطيئة", question: "ما الأصناف التي لا تُباع، وهل أحذفها أو أروّج لها؟" },
  { label: "المخزون", question: "ما المواد التي أوشكت على النفاد وما الذي يجب أن أشتريه أولاً؟" },
  { label: "أداء الموظفين", question: "من هم الموظفون الأفضل أداءً في المبيعات؟" },
  { label: "الإلغاءات والخصومات", question: "كم الإلغاءات والخصومات والمرتجعات وما تأثيرها على المبيعات؟" },
  { label: "حسب نوع الطلب", question: "كيف توزّعت المبيعات بين الصالة والسفري والتوصيل؟" },
  { label: "توصية", question: "ما هي توصيتك لزيادة أرباحنا بناءً على هذه البيانات؟" },
];

