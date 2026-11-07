import { useEffect, useRef, useState } from "react";
import { IconHelp, IconSend, IconX, IconBook } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { navigateTo } from "../../lib/appNav";
import { realErrorText } from "../../lib/errors";
import { parseAnswer, toHistory, type ChatMessage } from "../../lib/assistant";
import { excerptsFor, matchGuide, offlineAnswer, suggestionsFor, visibleChapters } from "../../lib/helpAnswer";
import { useAuthStore } from "../../stores/authStore";
import { usePlanStore } from "../../stores/planStore";

let nextId = 1;
const id = () => `help-${nextId++}`;

const WELCOME: ChatMessage = {
  id: "help-welcome",
  role: "assistant",
  intro: true,
  content: "اسألني عن أي شيء في استعمال النظام: «كيف أفتح الوردية؟»، «كيف أضيف صنفاً؟»، «كيف أطبع فاتورة قديمة؟». أجيب من دليل النظام نفسه.",
};

function Answer({ text }: { text: string }) {
  const blocks = parseAnswer(text);
  return (
    <div className="space-y-1.5 text-sm font-arabic leading-relaxed">
      {blocks.map((b, i) => {
        if (b.type === "ul") {
          return (
            <ul key={i} className="list-disc ps-5 space-y-0.5">
              {b.items.map((it, j) => <li key={j}>{it.map((s, k) => (s.bold ? <b key={k}>{s.text}</b> : <span key={k}>{s.text}</span>))}</li>)}
            </ul>
          );
        }
        const segs = b.segments.map((s, k) => (s.bold ? <b key={k}>{s.text}</b> : <span key={k}>{s.text}</span>));
        return b.type === "next" ? <p key={i} className="text-accent-text font-medium">الخطوة التالية: {segs}</p> : <p key={i}>{segs}</p>;
      })}
    </div>
  );
}

/**
 * The help chat: a "?" in the top bar for everyone (a cashier too). It looks the question up in the
 * in-app guide and has the AI explain it from those pages; with no internet it shows the guide pages
 * themselves, so it is useful even offline. It never guesses beyond the guide (that is what the
 * "assistant" page is for, with the shop's own numbers).
 */
export default function HelpChat() {
  const token = useAuthStore((s) => s.token);
  const role = useAuthStore((s) => s.user?.role);
  const posLite = usePlanStore((s) => s.posLite);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages, busy]);

  const ask = async (raw: string) => {
    const q = raw.trim();
    if (!q || busy) return;
    const history = toHistory(messages);
    setMessages((m) => [...m, { id: id(), role: "user", content: q }]);
    setText("");
    setBusy(true);
    const matches = matchGuide(q, visibleChapters(role, posLite));
    try {
      const a = await invoke<{ text: string }>("ask_help_v3", { sessionToken: token, question: q, guide: excerptsFor(matches), history });
      setMessages((m) => [...m, { id: id(), role: "assistant", content: a.text }]);
    } catch (e) {
      // No AI (no internet, no licence, over the limit): the guide pages themselves are still an answer.
      const reason = realErrorText(e);
      setMessages((m) => [...m, {
        id: id(), role: "assistant",
        content: `${matches.length ? "هذا ما وجدته في دليل النظام:\n\n" : ""}${offlineAnswer(matches)}${matches.length ? `\n\n(الشرح الذكي غير متاح الآن: ${reason})` : ""}`,
      }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="مساعدة"
        aria-expanded={open}
        data-testid="help-button"
        className="w-9 h-9 rounded-[10px] flex items-center justify-center text-text-muted hover:bg-surface-alt transition-colors"
      >
        <IconHelp className="w-[18px] h-[18px]" />
      </button>
      {open && (
        <aside
          className="fixed top-14 bottom-0 left-0 w-[380px] max-w-[94vw] bg-surface border-r border-line shadow-2xl z-40 flex flex-col animate-[slideInLeft_180ms_ease-out]"
          dir="rtl"
          data-testid="help-panel"
        >
          <div className="h-12 shrink-0 px-4 border-b border-line flex items-center justify-between">
            <span className="font-arabic font-bold text-text">مساعدة WENZDES</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => { setOpen(false); navigateTo("guide"); }} className="h-8 px-2.5 rounded-md text-xs font-arabic text-text-2 hover:bg-surface-alt flex items-center gap-1" data-testid="help-open-guide">
                <IconBook className="w-4 h-4" />الدليل الكامل
              </button>
              <button type="button" onClick={() => setOpen(false)} aria-label="إغلاق" className="w-8 h-8 rounded-md hover:bg-surface-alt flex items-center justify-center text-text-muted"><IconX className="w-4 h-4" /></button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3" data-testid="help-messages">
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={`max-w-[92%] rounded-xl px-3.5 py-2.5 ${m.role === "user" ? "bg-accent text-white text-sm font-arabic" : "bg-surface-alt text-text"}`} data-testid={`help-msg-${m.role}`}>
                  {m.role === "user" ? m.content : <Answer text={m.content} />}
                </div>
              </div>
            ))}
            {busy && <div className="text-sm text-text-muted font-arabic" data-testid="help-busy">أبحث في الدليل…</div>}
            {messages.length === 1 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {suggestionsFor(role).map((s) => (
                  <button key={s} type="button" onClick={() => void ask(s)} className="h-8 px-3 rounded-full border border-line text-xs font-arabic text-text-2 hover:border-accent hover:text-accent-text">{s}</button>
                ))}
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form
            className="shrink-0 p-3 border-t border-line flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); void ask(text); }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="اكتب سؤالك عن النظام…"
              maxLength={500}
              data-testid="help-input"
              className="flex-1 h-11 rounded-lg border-2 border-line px-3 text-sm font-arabic outline-none focus:border-accent bg-surface"
            />
            <button type="submit" disabled={busy || !text.trim()} aria-label="إرسال" data-testid="help-send" className="w-11 h-11 rounded-lg bg-accent text-white flex items-center justify-center disabled:opacity-40">
              <IconSend className="w-4 h-4" />
            </button>
          </form>
        </aside>
      )}
    </>
  );
}
