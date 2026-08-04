import { useState, useRef, useEffect } from "react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { Bot, Send, User, Sparkles } from "lucide-react";
import { IconChartBar, IconPackage, IconTrophy, IconUsers, IconAlertTriangle, IconBulb } from "@tabler/icons-react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface AssistantAnswer {
  text: string;
  confidence: number;
}

const QUICK_ACTIONS = [
  { label: "مبيعات اليوم", icon: IconChartBar, query: "كم بعنا اليوم وكم عدد الطلبات؟" },
  { label: "المخزون المنخفض", icon: IconPackage, query: "ما هي المواد منخفضة المخزون حالياً؟" },
  { label: "أفضل الأصناف", icon: IconTrophy, query: "ما هي أفضل الأصناف مبيعاً في هذه الفترة؟" },
  { label: "أداء الموظفين", icon: IconUsers, query: "من هم الموظفون الأفضل أداءً في المبيعات؟" },
  { label: "الإلغاءات", icon: IconAlertTriangle, query: "كم عدد عمليات الإلغاء وما تأثيرها على المبيعات؟" },
  { label: "توصية", icon: IconBulb, query: "ما هي توصيتك لزيادة مبيعاتنا بناءً على هذه البيانات؟" },
];

type Range = "today" | "week" | "month";

const RANGE_LABEL: Record<Range, string> = {
  today: "اليوم",
  week: "آخر 7 أيام",
  month: "آخر 30 يوماً",
};

function rangeToIso(range: Range): { startIso: string; endIso: string } {
  const now = new Date();
  const end = now.toISOString();
  const start = new Date(now);
  if (range === "today") {
    start.setHours(0, 0, 0, 0);
  } else if (range === "week") {
    start.setDate(start.getDate() - 7);
  } else {
    start.setDate(start.getDate() - 30);
  }
  return { startIso: start.toISOString(), endIso: end };
}

export default function AIPage() {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const [range, setRange] = useState<Range>("today");
  const [messages, setMessages] = useState<Message[]>([{
    id: "welcome",
    role: "assistant",
    content: "مرحباً! أنا مساعدك الذكي لمطعمك. اسألني عن مبيعاتك، أصنافك، أداء موظفيك، أو اطلب توصية -- وسأجيبك بالاعتماد على بياناتك الحقيقية فقط، للفترة المحددة أدناه.",
    timestamp: new Date().toISOString(),
  }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (content?: string) => {
    const text = (content || input).trim();
    if (!text || loading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    const { startIso, endIso } = rangeToIso(range);
    let responseText: string;
    try {
      const answer = await invoke<AssistantAnswer>("ask_assistant_v3", {
        sessionToken: token,
        question: text,
        startIso,
        endIso,
      });
      responseText = answer.text;
    } catch (err) {
      responseText = `تعذّر الوصول إلى المساعد الذكي: ${String(err).replace(/^Error:\s*/, "")}`;
    }

    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: responseText,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, assistantMsg]);
    setLoading(false);
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

  return (
    <div className="h-full flex flex-col" dir="rtl">
      <div className="bg-saffron-600 text-white px-6 py-4 flex items-center gap-3">
        <Bot className="w-6 h-6" />
        <div>
          <h1 className="font-bold">المساعد الذكي للمطعم</h1>
          <p className="text-saffron-100 text-xs">مدعوم بالذكاء الاصطناعي -- يجيب من بيانات مطعمك الحقيقية فقط</p>
        </div>
        <div className="mr-auto flex items-center gap-1 bg-saffron-500/30 px-3 py-1 rounded-full text-xs">
          <Sparkles className="w-3 h-3" />
          <span>مميز</span>
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-ink-200">
        <span className="text-xs text-ink-400">الفترة:</span>
        {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              range === r ? "bg-saffron-600 text-white" : "bg-ink-50 text-ink-500 hover:bg-ink-100"
            }`}
          >
            {RANGE_LABEL[r]}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-ink-50">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-start flex-row-reverse" : ""}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === "assistant" ? "bg-saffron-100 text-saffron-600" : "bg-ink-100 text-ink-600"}`}>
              {msg.role === "assistant" ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
            </div>
            <div className={`max-w-[80%] rounded-md p-4 text-sm leading-relaxed ${
              msg.role === "assistant" ? "bg-white border border-ink-200 text-ink-900" : "bg-saffron-600 text-white"
            }`}>
              <div className="whitespace-pre-wrap font-arabic">{msg.content}</div>
              <p className={`text-xs mt-2 ${msg.role === "assistant" ? "text-ink-400" : "text-saffron-200"}`}>
                {new Date(msg.timestamp).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-saffron-100 text-saffron-600 flex items-center justify-center">
              <Bot className="w-4 h-4" />
            </div>
            <div className="bg-white rounded-md p-4 border border-ink-200">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-saffron-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-2 h-2 bg-saffron-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-2 h-2 bg-saffron-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {messages.length <= 2 && (
        <div className="px-4 pb-2">
          <p className="text-xs text-ink-400 font-arabic mb-2 text-center">أسئلة سريعة</p>
          <div className="flex flex-wrap gap-2 justify-center">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.label}
                onClick={() => handleSend(action.query)}
                className="px-4 py-2 rounded-sm bg-white border border-ink-200 text-sm text-ink-700 font-arabic hover:border-saffron-300 hover:text-saffron-600 transition-colors inline-flex items-center gap-1.5"
              >
                <action.icon className="w-4 h-4" /> {action.label}
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
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="اسأل عن المبيعات، المخزون، الموظفين، أو اطلب توصية..."
            className="flex-1 h-12 px-4 rounded-sm bg-white border border-ink-200 text-sm outline-none focus:border-saffron-500 font-arabic"
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || loading}
            className="h-12 w-12 rounded-sm bg-saffron-600 text-white flex items-center justify-center hover:bg-saffron-700 transition-colors disabled:opacity-40"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
