import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "../../stores/authStore";
import { Bot, Send, User, Sparkles } from "lucide-react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

const QUICK_ACTIONS = [
  { label: "مبيعات اليوم", icon: "📊", query: "عرض ملخص مبيعات اليوم" },
  { label: "المخزون المنخفض", icon: "📦", query: "أظهر المواد منخفضة المخزون" },
  { label: "حضور الموظفين", icon: "👥", query: "من الموظفون الحاضرون اليوم؟" },
  { label: "الطلبات النشطة", icon: "🛵", query: "عرض الطلبات النشطة حالياً" },
  { label: "أعلى مبيعات", icon: "🏆", query: "ما هي أفضل الأصناف مبيعاً؟" },
  { label: "الديون", icon: "💳", query: "عرض الديون المستحقة" },
];

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR" }).format(cents / 100);
}

function formatTime(iso: string | null): string {
  if (!iso) return "---";
  return new Date(iso).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
}

export default function AIPage() {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const [messages, setMessages] = useState<Message[]>([{
    id: "welcome",
    role: "assistant",
    content: "مرحباً بك في المساعد الذكي للمطعم! يمكنني مساعدتك في:\n\n• عرض تقارير المبيعات والإيرادات\n• مراقبة المخزون والمواد منخفضة المخزون\n• متابعة حضور الموظفين\n• عرض الطلبات النشطة وحالة التوصيل\n• تحليل أفضل الأصناف مبيعاً\n• متابعة الديون والمستحقات\n\nاختر أحد الخيارات السريعة أدناه أو اكتب سؤالك مباشرة.",
    timestamp: new Date().toISOString(),
  }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const executeQuery = async (query: string): Promise<string> => {
    try {
      const q = query.toLowerCase();

      if (q.includes("مبيعات") || q.includes("إيرادات") || q.includes("اليوم")) {
        const today = new Date().toISOString().slice(0, 10);
        const revenue = await invoke<{ order_count: number; total: number }>(
          "get_finance_revenue_v3", { sessionToken: token, startIso: `${today}T00:00:00`, endIso: `${today}T23:59:59` }
        );
        const avg = revenue.order_count > 0 ? revenue.total / revenue.order_count : 0;
        return `📊 **ملخص مبيعات اليوم (${today})**\n\n• إجمالي المبيعات: ${formatCurrency(revenue.total)}\n• عدد الطلبات: ${revenue.order_count}\n• متوسط قيمة الطلب: ${formatCurrency(avg)}\n• الوقت: ${new Date().toLocaleTimeString("ar-SA")}`;
      }

      if (q.includes("مخزون") || q.includes("منخفض")) {
        const items = await invoke<{ name: string; current_stock: number; min_stock: number; unit: string }[]>(
          "list_low_stock_ingredients_v3", { sessionToken: token }
        );
        if (items.length === 0) return "✅ جميع المواد ضمن الحد الآمن. المخزون بحالة ممتازة.";
        let resp = `⚠️ **المواد منخفضة المخزون (${items.length})**\n\n`;
        for (const item of items) {
          resp += `• ${item.name}: المخزون ${item.current_stock} / الحد الأدنى ${item.min_stock} ${item.unit}\n`;
        }
        return resp;
      }

      if (q.includes("حضور") || q.includes("موظف") || q.includes("الحاضر")) {
        const today = new Date().toISOString().slice(0, 10);
        const att = await invoke<{ user_name: string; clock_in: string | null; status: string }[]>(
          "list_attendance_v3", { sessionToken: token, dateFrom: today, dateTo: today, userId: null }
        );
        if (att.length === 0) return "👥 لم يسجل أي موظف حضور اليوم بعد.";
        const present = att.filter((a) => a.status === "PRESENT" || a.status === "LATE");
        const late = att.filter((a) => a.status === "LATE");
        let resp = `👥 **الحضور اليوم (${today})**\n\n`;
        resp += `• إجمالي المسجلين: ${att.length}\n`;
        resp += `• الحاضرون: ${present.length}\n`;
        if (late.length > 0) resp += `• المتأخرون: ${late.length}\n\n`;
        for (const a of present) {
          resp += `• ${a.user_name}: ${formatTime(a.clock_in)}${a.status === "LATE" ? " ⚠️ متأخر" : ""}\n`;
        }
        return resp;
      }

      if (q.includes("طلب") || q.includes("نشط")) {
        const orders = await invoke<{ id: string; status: string; order_type: string; total_cents: number }[]>(
          "list_orders_v3", { sessionToken: token }
        );
        const active = orders.filter((o) => ["PENDING", "PREPARING", "READY"].includes(o.status)).slice(0, 20);
        if (active.length === 0) return "📋 لا توجد طلبات نشطة حالياً.";
        let resp = `📋 **الطلبات النشطة (${active.length})**\n\n`;
        for (const o of active) {
          const typeLabel = o.order_type === "DINE_IN" ? "داخلي" : o.order_type === "TAKEAWAY" ? "طلبية خارجية" : "توصيل";
          resp += `• #${o.id.slice(0, 6)} | ${typeLabel} | ${formatCurrency(o.total_cents)} | ${o.status === "PENDING" ? "قيد الانتظار" : o.status === "PREPARING" ? "قيد التحضير" : "جاهز"}\n`;
        }
        return resp;
      }

      if (q.includes("أفضل") || q.includes("مبيع") || q.includes("الأصناف")) {
        const today = new Date().toISOString().slice(0, 10);
        const report = await invoke<{ top_items: { name: string; quantity: number }[] }>(
          "get_sales_report_v3", { sessionToken: token, todayStartIso: `${today}T00:00:00` }
        );
        if (report.top_items.length === 0) return "🏆 لا توجد بيانات مبيعات كافية للتحليل.";
        let resp = `🏆 **أفضل الأصناف مبيعاً**\n\n`;
        report.top_items.forEach((item, i) => {
          resp += `${i + 1}. ${item.name}: ${item.quantity} وحدة\n`;
        });
        return resp;
      }

      if (q.includes("ديون") || q.includes("مستحقات")) {
        const debtors = await invoke<{ name: string; is_active: number; balance_cents: number }[]>(
          "list_debtors_v3", { sessionToken: token }
        );
        const owing = debtors.filter((d) => d.is_active && d.balance_cents > 0).sort((a, b) => b.balance_cents - a.balance_cents).slice(0, 10);
        if (owing.length === 0) return "💳 لا توجد ديون مستحقة. جميع الحسابات مسددة.";
        const total = owing.reduce((a, d) => a + d.balance_cents, 0);
        let resp = `💳 **الديون المستحقة (${owing.length} عميل)**\n\n`;
        resp += `إجمالي الديون: ${formatCurrency(total)}\n\n`;
        for (const d of owing) {
          resp += `• ${d.name}: ${formatCurrency(d.balance_cents)}\n`;
        }
        return resp;
      }

      return "عذراً، لم أتمكن من فهم طلبك. يرجى اختيار أحد الخيارات السريعة أدناه أو إعادة صياغة السؤال.\n\nالخيارات المتاحة:\n• مبيعات اليوم\n• المخزون المنخفض\n• حضور الموظفين\n• الطلبات النشطة\n• أفضل الأصناف مبيعاً\n• الديون المستحقة";
    } catch {
      return "حدث خطأ أثناء تنفيذ الاستعلام. يرجى المحاولة مرة أخرى.";
    }
  };

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

    const result = await executeQuery(text);

    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: result,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, assistantMsg]);
    setLoading(false);
  };

  if (user?.role !== "OWNER") {
    return (
      <div className="p-6 h-full flex items-center justify-center" dir="rtl">
        <div className="text-center space-y-4">
          <Bot className="w-16 h-16 mx-auto text-ink-300" />
          <h1 className="text-xl font-bold text-ink-900">المساعد الذكي</h1>
          <p className="text-ink-500 font-arabic">هذه الميزة متاحة فقط لصاحب المنشأة. يرجى تسجيل الدخول بحساب المالك.</p>
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
          <p className="text-saffron-100 text-xs">مدعوم بالذكاء الاصطناعي - إصدار المالك</p>
        </div>
        <div className="mr-auto flex items-center gap-1 bg-saffron-500/30 px-3 py-1 rounded-full text-xs">
          <Sparkles className="w-3 h-3" />
          <span>مميز</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-ink-50">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-start flex-row-reverse" : ""}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === "assistant" ? "bg-saffron-100 text-saffron-600" : "bg-indigo-100 text-indigo-600"}`}>
              {msg.role === "assistant" ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
            </div>
            <div className={`max-w-[80%] rounded-2xl p-4 text-sm leading-relaxed ${
              msg.role === "assistant" ? "bg-white shadow-sh-1 text-ink-900" : "bg-saffron-600 text-white"
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
            <div className="bg-white rounded-2xl p-4 shadow-sh-1">
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
                className="px-4 py-2 rounded-xl bg-white border border-ink-200 text-sm text-ink-700 font-arabic hover:border-saffron-300 hover:text-saffron-600 transition-colors shadow-sh-1"
              >
                {action.icon} {action.label}
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
            placeholder="اسأل عن المبيعات، المخزون، الموظفين..."
            className="flex-1 h-12 px-4 rounded-xl bg-white border border-ink-200 text-sm outline-none focus:border-saffron-500 font-arabic"
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || loading}
            className="h-12 w-12 rounded-xl bg-saffron-600 text-white flex items-center justify-center hover:bg-saffron-700 transition-colors disabled:opacity-40"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
