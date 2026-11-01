import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import {
  IconRobot as Bot, IconSend as Send, IconUser as User, IconSparkles as Sparkles,
  IconCopy, IconRefresh, IconPlus, IconTrendingUp, IconTrendingDown, IconAlertTriangle, IconInfoCircle,
} from "@tabler/icons-react";
import { formatArabicTime } from "../../lib/dateLocal";
import {
  buildPeriods, rangeToIso, nowLocalLabel, tzOffsetMinutes, toHistory, errorText, parseAnswer,
  FOLLOW_UPS, QUICK_QUESTIONS, type ChatMessage, type Range, type Segment,
} from "../../lib/assistant";

interface Message extends ChatMessage {
  timestamp: string;
  /** the question that produced this (error) answer, so "retry" can ask it again */
  retryOf?: string;
}

interface AssistantAnswer {
  text: string;
  // `null` when the provider has no real confidence signal (the real remote
  // provider always sends null). Not rendered; typed honestly.
  confidence: number | null;
}

interface Insight {
  kind: "up" | "down" | "warn" | "info";
  text: string;
  question: string;
}

const RANGE_LABEL: Record<Range, string> = {
  today: "اليوم",
  week: "آخر 7 أيام",
  month: "آخر 30 يوماً",
};

const WELCOME: Message = {
  id: "welcome",
  role: "assistant",
  intro: true,
  content: "مرحباً! أنا مساعدك الذكي لمنشأتك. اسألني عن المبيعات، الأرباح، الأصناف، ساعات الذروة، المخزون أو الموظفين، أو اطلب توصية. أجيبك من بياناتك الحقيقية فقط، وأفهم المتابعة (مثل: «وأمس؟»).",
  timestamp: new Date().toISOString(),
};

const INSIGHT_STYLE: Record<Insight["kind"], { box: string; Icon: typeof IconInfoCircle }> = {
  up: { box: "border-emerald-200 bg-emerald-50 text-emerald-800", Icon: IconTrendingUp },
  down: { box: "border-red-200 bg-red-50 text-red-800", Icon: IconTrendingDown },
  warn: { box: "border-amber-200 bg-amber-50 text-amber-800", Icon: IconAlertTriangle },
  info: { box: "border-ink-200 bg-white text-ink-700", Icon: IconInfoCircle },
};

function Inline({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((s, i) => (s.bold ? <strong key={i} className="font-bold">{s.text}</strong> : <span key={i}>{s.text}</span>))}
    </>
  );
}

/** An answer as paragraphs, bullet lists and a "next step" callout. Plain React text -- never HTML. */
function AnswerBody({ text }: { text: string }) {
  const blocks = parseAnswer(text);
  return (
    <div className="space-y-2 font-arabic" data-testid="ai-chat-message-text">
      {blocks.map((b, i) =>
        b.type === "ul" ? (
          <ul key={i} className="list-disc pr-5 space-y-1">
            {b.items.map((it, j) => <li key={j}><Inline segments={it} /></li>)}
          </ul>
        ) : b.type === "next" ? (
          <p key={i} className="rounded-md bg-saffron-50 text-saffron-700 px-3 py-2 text-[13px]">
            <span className="font-bold">الخطوة التالية: </span><Inline segments={b.segments} />
          </p>
        ) : (
          <p key={i}><Inline segments={b.segments} /></p>
        ),
      )}
    </div>
  );
}

export default function AIPage() {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const [range, setRange] = useState<Range>("today");
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // A "still working" hint if the answer takes more than a few seconds.
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(t);
  }, [loading]);

  // Plain findings computed on the till (no AI call): sales up/down, voids, stock.
  useEffect(() => {
    if (!token) return;
    const now = new Date();
    invoke<Insight[]>("assistant_insights_v3", { sessionToken: token, tzOffsetMinutes: tzOffsetMinutes(now), periods: buildPeriods(now) })
      .then((r) => setInsights(Array.isArray(r) ? r : []))
      .catch(() => setInsights([]));
  }, [token]);

  const ask = useCallback(
    async (text: string, opts?: { retry?: boolean }) => {
      const q = text.trim();
      if (!q || loading) return;
      const history = toHistory(messages);
      if (opts?.retry) {
        // drop the failed answer; the user's question is already on screen
        setMessages((prev) => prev.filter((m) => !(m.error && m.retryOf === q)));
      } else {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: q, timestamp: new Date().toISOString() }]);
        setInput("");
      }
      setLoading(true);

      const now = new Date();
      const { startIso, endIso } = rangeToIso(range, now);
      try {
        const answer = await invoke<AssistantAnswer>("ask_assistant_v3", {
          sessionToken: token,
          question: q,
          startIso,
          endIso,
          tzOffsetMinutes: tzOffsetMinutes(now),
          nowLocal: nowLocalLabel(now),
          periods: buildPeriods(now),
          history,
        });
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: answer.text, timestamp: new Date().toISOString() }]);
      } catch (err) {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: errorText(err), error: true, retryOf: q, timestamp: new Date().toISOString() }]);
      } finally {
        setLoading(false);
      }
    },
    [loading, messages, range, token],
  );

  const copy = async (m: Message) => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopied(m.id);
      setTimeout(() => setCopied((c) => (c === m.id ? null : c)), 1500);
    } catch {
      /* clipboard unavailable: nothing to do */
    }
  };

  if (user?.role !== "OWNER" && user?.role !== "MANAGER") {
    return (
      <div className="p-6 h-full flex items-center justify-center" dir="rtl">
        <div className="text-center space-y-4">
          <Bot className="w-16 h-16 mx-auto text-ink-300" />
          <h1 className="text-xl font-bold text-ink-900">المساعد الذكي</h1>
          <p className="text-ink-500 font-arabic">هذه الميزة متاحة فقط للمدير والمشرف.</p>
        </div>
      </div>
    );
  }

  const fresh = messages.length <= 1;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  const showFollowUps = !loading && last && last.role === "assistant" && !last.error && !last.intro;

  return (
    <div className="h-full flex flex-col" dir="rtl">
      <div className="px-6 py-4 flex items-center gap-3 bg-canvas border-b border-ink-200">
        <div className="w-10 h-10 rounded-md bg-saffron-50 flex items-center justify-center shrink-0">
          <Bot className="w-5 h-5 text-saffron-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-ink-900">المساعد الذكي</h1>
          <p className="text-ink-500 text-xs">مدعوم بالذكاء الاصطناعي — يجيب من بيانات منشأتك الحقيقية فقط</p>
        </div>
        <div className="mr-auto flex items-center gap-2">
          {!fresh && (
            <button
              onClick={() => setMessages([{ ...WELCOME, timestamp: new Date().toISOString() }])}
              disabled={loading}
              data-testid="ai-chat-new"
              className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-ink-50 text-ink-600 hover:bg-ink-100 disabled:opacity-40"
            >
              <IconPlus className="w-3 h-3" /> محادثة جديدة
            </button>
          )}
          <div className="flex items-center gap-1 bg-saffron-50 text-saffron-600 px-3 py-1 rounded-full text-xs font-medium">
            <Sparkles className="w-3 h-3" />
            <span>مميز</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-ink-200">
        <span className="text-xs text-ink-400">الفترة:</span>
        {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            data-testid={`ai-range-${r}`}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              range === r ? "bg-saffron-600 text-white" : "bg-ink-50 text-ink-500 hover:bg-ink-100"
            }`}
          >
            {RANGE_LABEL[r]}
          </button>
        ))}
        <span className="text-[11px] text-ink-400 mr-2">يعرف المساعد أيضاً أمس والأسبوع الماضي والشهر، فاسأل عنها مباشرة.</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-ink-50">
        {fresh && insights.length > 0 && (
          <div className="max-w-3xl mx-auto space-y-2" data-testid="ai-insights">
            <p className="text-xs text-ink-400 font-arabic">ما لاحظته في بياناتك (اضغط لتسأل عنه)</p>
            {insights.map((it, i) => {
              const { box, Icon } = INSIGHT_STYLE[it.kind] ?? INSIGHT_STYLE.info;
              return (
                <button
                  key={i}
                  onClick={() => ask(it.question)}
                  data-testid="ai-insight"
                  className={`w-full text-right flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-arabic hover:shadow-sh-1 transition-shadow ${box}`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1">{it.text}</span>
                  <span className="text-[11px] opacity-70">اسأل ←</span>
                </button>
              );
            })}
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-start flex-row-reverse" : ""}`} data-testid={`ai-chat-message-${msg.role}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === "assistant" ? "bg-saffron-100 text-saffron-600" : "bg-ink-100 text-ink-600"}`}>
              {msg.role === "assistant" ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
            </div>
            <div className={`max-w-[80%] rounded-lg p-4 text-sm leading-relaxed shadow-sh-1 ${
              msg.error ? "bg-red-50 border border-red-200 text-red-800"
                : msg.role === "assistant" ? "bg-white border border-ink-200 text-ink-900" : "bg-saffron-600 text-white"
            }`}>
              {msg.role === "assistant" && !msg.error ? (
                <AnswerBody text={msg.content} />
              ) : (
                <div className="whitespace-pre-wrap font-arabic" data-testid="ai-chat-message-text">{msg.content}</div>
              )}
              <div className={`mt-2 flex items-center gap-3 text-xs ${msg.error ? "text-red-400" : msg.role === "assistant" ? "text-ink-400" : "text-saffron-200"}`}>
                <span>{formatArabicTime(new Date(msg.timestamp), { hour: "2-digit", minute: "2-digit" })}</span>
                {msg.error && msg.retryOf && (
                  <button onClick={() => ask(msg.retryOf!, { retry: true })} disabled={loading} data-testid="ai-chat-retry" className="inline-flex items-center gap-1 font-medium text-red-700 hover:underline disabled:opacity-40">
                    <IconRefresh className="w-3 h-3" /> إعادة المحاولة
                  </button>
                )}
                {msg.role === "assistant" && !msg.error && !msg.intro && (
                  <button onClick={() => copy(msg)} data-testid="ai-chat-copy" className="inline-flex items-center gap-1 hover:text-saffron-600">
                    <IconCopy className="w-3 h-3" /> {copied === msg.id ? "تم النسخ" : "نسخ"}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-3" data-testid="ai-chat-loading">
            <div className="w-8 h-8 rounded-full bg-saffron-100 text-saffron-600 flex items-center justify-center">
              <Bot className="w-4 h-4" />
            </div>
            <div className="bg-white rounded-lg p-4 border border-ink-200 shadow-sh-1">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-saffron-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-2 h-2 bg-saffron-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-2 h-2 bg-saffron-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              <p className="text-xs text-ink-400 font-arabic mt-2">
                {slow ? "ما زلت أحلّل بياناتك، قد يستغرق ذلك حتى نصف دقيقة…" : "أحلّل بياناتك…"}
              </p>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {showFollowUps && (
        <div className="px-4 pb-1 flex flex-wrap gap-2 justify-center" data-testid="ai-followups">
          {FOLLOW_UPS.map((f) => (
            <button key={f.label} onClick={() => ask(f.question)} className="px-3 py-1 rounded-full bg-white border border-ink-200 text-xs text-ink-600 font-arabic hover:border-saffron-300 hover:text-saffron-600">
              {f.label}
            </button>
          ))}
        </div>
      )}

      {fresh && (
        <div className="px-4 pb-2">
          <p className="text-xs text-ink-400 font-arabic mb-2 text-center">أسئلة سريعة</p>
          <div className="flex flex-wrap gap-2 justify-center">
            {QUICK_QUESTIONS.map((a) => (
              <button
                key={a.label}
                onClick={() => ask(a.question)}
                className="px-4 py-2 rounded-lg bg-white border border-ink-200 text-sm text-ink-700 font-arabic hover:border-saffron-300 hover:text-saffron-600 transition-colors"
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-ink-200 bg-white p-4">
        <div className="flex gap-2 max-w-4xl mx-auto">
          <input
            type="text"
            value={input}
            maxLength={1000}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && ask(input)}
            placeholder="اسأل عن المبيعات، الأرباح، المخزون، الموظفين، أو اطلب توصية..."
            data-testid="ai-chat-input"
            className="flex-1 h-12 px-4 rounded-lg bg-white border border-ink-200 text-sm outline-none focus:border-saffron-500 font-arabic"
          />
          <button
            onClick={() => ask(input)}
            disabled={!input.trim() || loading}
            data-testid="ai-chat-send"
            className="h-12 w-12 rounded-lg bg-saffron-600 text-white flex items-center justify-center hover:bg-saffron-700 transition-colors disabled:opacity-40"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
