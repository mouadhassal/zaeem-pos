import { useState, useRef, useEffect } from "react";
import { useAuthStore } from "../../stores/authStore";
import { getDb } from "../../db";
import { sql } from "kysely";
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
      const db = await getDb();
      const q = query.toLowerCase();

      if (q.includes("مبيعات") || q.includes("إيرادات") || q.includes("اليوم")) {
        const today = new Date().toISOString().slice(0, 10);
        const orders = await db.selectFrom("orders")
          .select([db.fn.count<number>("id").as("count"), db.fn.sum<number>("total_cents").as("total")])
          .where("status", "=", "PAID")
          .where("created_at", ">=", today)
          .executeTakeFirst();
        const total = orders?.total ?? 0;
        const count = orders?.count ?? 0;
        const avg = count > 0 ? total / count : 0;
        return `📊 **ملخص مبيعات اليوم (${today})**\n\n• إجمالي المبيعات: ${formatCurrency(total)}\n• عدد الطلبات: ${count}\n• متوسط قيمة الطلب: ${formatCurrency(avg)}\n• الوقت: ${new Date().toLocaleTimeString("ar-SA")}`;
      }

      if (q.includes("مخزون") || q.includes("منخفض")) {
        const items = await db.selectFrom("ingredients")
          .selectAll()
          .where("is_active", "=", 1)
          .where("current_stock", "<", db.dynamic.ref("min_stock") as any)
          .orderBy("current_stock", "asc")
          .execute();
        if (items.length === 0) return "✅ جميع المواد ضمن الحد الآمن. المخزون بحالة ممتازة.";
        let resp = `⚠️ **المواد منخفضة المخزون (${items.length})**\n\n`;
        for (const item of items) {
          resp += `• ${item.name}: المخزون ${item.current_stock} / الحد الأدنى ${item.min_stock} ${item.unit}\n`;
        }
        return resp;
      }

      if (q.includes("حضور") || q.includes("موظف") || q.includes("الحاضر")) {
        const today = new Date().toISOString().slice(0, 10);
        const att = await db.selectFrom("attendance")
          .innerJoin("users", "users.id", "attendance.user_id")
          .select(["users.name", "attendance.clock_in", "attendance.status"])
          .where("attendance.date", "=", today)
          .execute();
        if (att.length === 0) return "👥 لم يسجل أي موظف حضور اليوم بعد.";
        const present = att.filter((a) => a.status === "PRESENT" || a.status === "LATE");
        const late = att.filter((a) => a.status === "LATE");
        let resp = `👥 **الحضور اليوم (${today})**\n\n`;
        resp += `• إجمالي المسجلين: ${att.length}\n`;
        resp += `• الحاضرون: ${present.length}\n`;
        if (late.length > 0) resp += `• المتأخرون: ${late.length}\n\n`;
        for (const a of present) {
          resp += `• ${a.name}: ${formatTime(a.clock_in)}${a.status === "LATE" ? " ⚠️ متأخر" : ""}\n`;
        }
        return resp;
      }

      if (q.includes("طلب") || q.includes("نشط")) {
        const orders = await db.selectFrom("orders")
          .leftJoin("tables", "tables.id", "orders.table_id")
          .select(["orders.id", "orders.status", "orders.order_type", "orders.total_cents", "orders.customer_name", "tables.name as table_name"])
          .where("orders.status", "in", ["PENDING", "PREPARING", "READY"])
          .orderBy("orders.created_at", "desc")
          .limit(20)
          .execute();
        if (orders.length === 0) return "📋 لا توجد طلبات نشطة حالياً.";
        let resp = `📋 **الطلبات النشطة (${orders.length})**\n\n`;
        for (const o of orders) {
          const typeLabel = o.order_type === "DINE_IN" ? "داخلي" : o.order_type === "TAKEAWAY" ? "طلبية خارجية" : "توصيل";
          resp += `• #${o.id.slice(0, 6)} | ${o.table_name ?? o.customer_name ?? "—"} | ${typeLabel} | ${formatCurrency(o.total_cents)} | ${o.status === "PENDING" ? "قيد الانتظار" : o.status === "PREPARING" ? "قيد التحضير" : "جاهز"}\n`;
        }
        return resp;
      }

      if (q.includes("أفضل") || q.includes("مبيع") || q.includes("الأصناف")) {
        const items = await db.selectFrom("order_items")
          .innerJoin("menu_items", "menu_items.id", "order_items.menu_item_id")
          .select([
            "menu_items.name",
            sql<number>`SUM(order_items.quantity)`.as("total_qty"),
            sql<number>`SUM(order_items.quantity * order_items.unit_price_cents)`.as("total_revenue"),
          ])
          .groupBy("menu_items.name")
          .orderBy("total_qty", "desc")
          .limit(10)
          .execute();
        if (items.length === 0) return "🏆 لا توجد بيانات مبيعات كافية للتحليل.";
        let resp = `🏆 **أفضل الأصناف مبيعاً**\n\n`;
        items.forEach((item, i) => {
          resp += `${i + 1}. ${item.name}: ${item.total_qty} وحدة | ${formatCurrency(item.total_revenue ?? 0)}\n`;
        });
        return resp;
      }

      if (q.includes("ديون") || q.includes("مستحقات")) {
        const debtors = await db.selectFrom("debtors")
          .selectAll()
          .where("is_active", "=", 1)
          .where("balance_cents", ">", 0)
          .orderBy("balance_cents", "desc")
          .limit(10)
          .execute();
        if (debtors.length === 0) return "💳 لا توجد ديون مستحقة. جميع الحسابات مسددة.";
        const total = debtors.reduce((a, d) => a + d.balance_cents, 0);
        let resp = `💳 **الديون المستحقة (${debtors.length} عميل)**\n\n`;
        resp += `إجمالي الديون: ${formatCurrency(total)}\n\n`;
        for (const d of debtors) {
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
          <Bot className="w-16 h-16 mx-auto text-slate-300" />
          <h1 className="text-xl font-bold text-slate-900">المساعد الذكي</h1>
          <p className="text-slate-500 font-arabic">هذه الميزة متاحة فقط لصاحب المنشأة. يرجى تسجيل الدخول بحساب المالك.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" dir="rtl">
      <div className="bg-emerald-600 text-white px-6 py-4 flex items-center gap-3">
        <Bot className="w-6 h-6" />
        <div>
          <h1 className="font-bold">المساعد الذكي للمطعم</h1>
          <p className="text-emerald-100 text-xs">مدعوم بالذكاء الاصطناعي - إصدار المالك</p>
        </div>
        <div className="mr-auto flex items-center gap-1 bg-emerald-500/30 px-3 py-1 rounded-full text-xs">
          <Sparkles className="w-3 h-3" />
          <span>مميز</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-start flex-row-reverse" : ""}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === "assistant" ? "bg-emerald-100 text-emerald-600" : "bg-indigo-100 text-indigo-600"}`}>
              {msg.role === "assistant" ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
            </div>
            <div className={`max-w-[80%] rounded-2xl p-4 text-sm leading-relaxed ${
              msg.role === "assistant" ? "bg-white shadow-sm text-slate-900" : "bg-emerald-600 text-white"
            }`}>
              <div className="whitespace-pre-wrap font-arabic">{msg.content}</div>
              <p className={`text-xs mt-2 ${msg.role === "assistant" ? "text-slate-400" : "text-emerald-200"}`}>
                {new Date(msg.timestamp).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <Bot className="w-4 h-4" />
            </div>
            <div className="bg-white rounded-2xl p-4 shadow-sm">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {messages.length <= 2 && (
        <div className="px-4 pb-2">
          <p className="text-xs text-slate-400 font-arabic mb-2 text-center">أسئلة سريعة</p>
          <div className="flex flex-wrap gap-2 justify-center">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.label}
                onClick={() => handleSend(action.query)}
                className="px-4 py-2 rounded-xl bg-white border border-slate-200 text-sm text-slate-700 font-arabic hover:border-emerald-300 hover:text-emerald-600 transition-colors shadow-sm"
              >
                {action.icon} {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-slate-200 bg-white p-4">
        <div className="flex gap-2 max-w-4xl mx-auto">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="اسأل عن المبيعات، المخزون، الموظفين..."
            className="flex-1 h-12 px-4 rounded-xl bg-white border border-slate-200 text-sm outline-none focus:border-emerald-500 font-arabic"
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || loading}
            className="h-12 w-12 rounded-xl bg-emerald-600 text-white flex items-center justify-center hover:bg-emerald-700 transition-colors disabled:opacity-40"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
