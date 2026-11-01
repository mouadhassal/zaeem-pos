import { describe, it, expect } from "vitest";
import { buildPeriods, rangeToIso, nowLocalLabel, toHistory, parseAnswer, inlineSegments, errorText, tzOffsetMinutes, type ChatMessage } from "./assistant";

// A fixed local moment: Wednesday 11 March 2026, 14:30 (local time of the test machine).
const NOW = new Date(2026, 2, 11, 14, 30, 0);
const local = (iso: string) => new Date(iso);

describe("buildPeriods", () => {
  const periods = buildPeriods(NOW);
  const by = (label: string) => periods.find((p) => p.label === label)!;

  it("has every window the assistant is told about", () => {
    expect(periods.map((p) => p.label)).toEqual([
      "today", "yesterday", "same_weekday_last_week", "last_7_days", "previous_7_days", "this_month", "last_30_days", "previous_30_days",
    ]);
  });

  it("today runs from local midnight to now; yesterday is the whole local day before", () => {
    expect(local(by("today").start_iso)).toEqual(new Date(2026, 2, 11, 0, 0, 0, 0));
    expect(local(by("today").end_iso)).toEqual(NOW);
    expect(local(by("yesterday").start_iso)).toEqual(new Date(2026, 2, 10, 0, 0, 0, 0));
    expect(local(by("yesterday").end_iso)).toEqual(new Date(2026, 2, 10, 23, 59, 59, 999));
  });

  it("the last 7 days and the 7 before never overlap and touch exactly", () => {
    const last = by("last_7_days");
    const prev = by("previous_7_days");
    expect(local(last.start_iso)).toEqual(new Date(2026, 2, 5, 0, 0, 0, 0));
    expect(local(prev.start_iso)).toEqual(new Date(2026, 1, 26, 0, 0, 0, 0));
    expect(local(prev.end_iso).getTime() + 1).toBe(local(last.start_iso).getTime());
  });

  it("the same weekday last week is one whole day", () => {
    const d = by("same_weekday_last_week");
    expect(local(d.start_iso)).toEqual(new Date(2026, 2, 4, 0, 0, 0, 0));
    expect(local(d.end_iso)).toEqual(new Date(2026, 2, 4, 23, 59, 59, 999));
  });

  it("this month starts on the 1st; the 30-day windows touch exactly", () => {
    expect(local(by("this_month").start_iso)).toEqual(new Date(2026, 2, 1, 0, 0, 0, 0));
    expect(local(by("previous_30_days").end_iso).getTime() + 1).toBe(local(by("last_30_days").start_iso).getTime());
  });
});

describe("rangeToIso", () => {
  it("maps the chips to local-day windows", () => {
    expect(new Date(rangeToIso("today", NOW).startIso)).toEqual(new Date(2026, 2, 11));
    expect(new Date(rangeToIso("week", NOW).startIso)).toEqual(new Date(2026, 2, 5));
    expect(new Date(rangeToIso("month", NOW).startIso)).toEqual(new Date(2026, 1, 10));
    expect(new Date(rangeToIso("week", NOW).endIso)).toEqual(NOW);
  });
});

describe("clock labels", () => {
  it("names the local date, weekday and time", () => {
    expect(nowLocalLabel(NOW)).toBe("2026-03-11 (الأربعاء) 14:30");
  });
  it("offset is minutes east of UTC", () => {
    expect(tzOffsetMinutes(NOW)).toBe(-NOW.getTimezoneOffset());
  });
});

describe("toHistory", () => {
  const m = (role: "user" | "assistant", content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: content, role, content, ...extra });
  it("drops the welcome bubble and failed answers, keeps order, caps at 6", () => {
    const msgs = [m("assistant", "welcome", { intro: true }), m("user", "q1"), m("assistant", "boom", { error: true }), m("user", "q1"), m("assistant", "a1"),
      m("user", "q2"), m("assistant", "a2"), m("user", "q3"), m("assistant", "a3"), m("user", "q4")];
    const h = toHistory(msgs);
    expect(h).toHaveLength(6);
    expect(h[h.length - 1]).toEqual({ role: "user", text: "q4" });
    expect(h.some((t) => t.text === "boom" || t.text === "welcome")).toBe(false);
  });
});

describe("toHistory with a failed exchange", () => {
  it("leaves out the question whose answer failed", () => {
    const h = toHistory([
      { id: "1", role: "user", content: "q1" }, { id: "2", role: "assistant", content: "a1" },
      { id: "3", role: "user", content: "q2" }, { id: "4", role: "assistant", content: "net down", error: true },
    ]);
    expect(h).toEqual([{ role: "user", text: "q1" }, { role: "assistant", text: "a1" }]);
  });
});

describe("errorText", () => {
  it("strips the Error: prefix and never returns an empty string", () => {
    expect(errorText(new Error("لا يوجد اتصال"))).toBe("لا يوجد اتصال");
    expect(errorText("Error: لا يوجد ترخيص")).toBe("لا يوجد ترخيص");
    expect(errorText("")).toContain("تعذّر");
  });
});

describe("parseAnswer", () => {
  it("splits paragraphs, bullet lists and the next-step callout", () => {
    const blocks = parseAnswer("بعنا **120,000 ل.س** اليوم.\n- كباب: 40\n- شاورما: 30\n\nالخطوة التالية: راجع المخزون");
    expect(blocks.map((b) => b.type)).toEqual(["p", "ul", "next"]);
    const p = blocks[0] as { segments: { text: string; bold: boolean }[] };
    expect(p.segments.map((s) => [s.text, s.bold])).toEqual([["بعنا ", false], ["120,000 ل.س", true], [" اليوم.", false]]);
    expect((blocks[1] as { items: unknown[][] }).items).toHaveLength(2);
    expect((blocks[2] as { segments: { text: string }[] }).segments[0].text).toBe("راجع المخزون");
  });
  it("treats numbered lines and • as bullets", () => {
    expect(parseAnswer("1. أولاً\n2) ثانياً\n• ثالثاً")[0]).toMatchObject({ type: "ul" });
  });
  it("leaves an unmatched ** literal and never produces HTML", () => {
    expect(inlineSegments("a ** b")).toEqual([{ text: "a ** b", bold: false }]);
    const b = parseAnswer("<script>alert(1)</script>")[0] as { segments: { text: string }[] };
    expect(b.segments[0].text).toBe("<script>alert(1)</script>");
  });
});
