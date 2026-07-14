import{c as _,u as v,r as m,j as e,B as x,U as S}from"./index-aM8QPgYu.js";import{g as k,s as N}from"./index-D2xfRZ6r.js";/**
 * @license lucide-react v1.23.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const I=[["path",{d:"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",key:"1ffxy3"}],["path",{d:"m21.854 2.147-10.94 10.939",key:"12cjpa"}]],A=_("send",I);/**
 * @license lucide-react v1.23.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const D=[["path",{d:"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",key:"1s2grr"}],["path",{d:"M20 2v4",key:"1rf3ol"}],["path",{d:"M22 4h-4",key:"gwowj6"}],["circle",{cx:"4",cy:"20",r:"2",key:"6kqj1y"}]],E=_("sparkles",D),q=[{label:"مبيعات اليوم",icon:"📊",query:"عرض ملخص مبيعات اليوم"},{label:"المخزون المنخفض",icon:"📦",query:"أظهر المواد منخفضة المخزون"},{label:"حضور الموظفين",icon:"👥",query:"من الموظفون الحاضرون اليوم؟"},{label:"الطلبات النشطة",icon:"🛵",query:"عرض الطلبات النشطة حالياً"},{label:"أعلى مبيعات",icon:"🏆",query:"ما هي أفضل الأصناف مبيعاً؟"},{label:"الديون",icon:"💳",query:"عرض الديون المستحقة"}];function u(o){return new Intl.NumberFormat("ar-SA",{style:"currency",currency:"SAR"}).format(o/100)}function R(o){return o?new Date(o).toLocaleTimeString("ar-SA",{hour:"2-digit",minute:"2-digit"}):"---"}function M(){const o=v(s=>s.user),[h,y]=m.useState([{id:"welcome",role:"assistant",content:`مرحباً بك في المساعد الذكي للمطعم! يمكنني مساعدتك في:

• عرض تقارير المبيعات والإيرادات
• مراقبة المخزون والمواد منخفضة المخزون
• متابعة حضور الموظفين
• عرض الطلبات النشطة وحالة التوصيل
• تحليل أفضل الأصناف مبيعاً
• متابعة الديون والمستحقات

اختر أحد الخيارات السريعة أدناه أو اكتب سؤالك مباشرة.`,timestamp:new Date().toISOString()}]),[f,g]=m.useState(""),[p,w]=m.useState(!1),j=m.useRef(null);m.useEffect(()=>{var s;(s=j.current)==null||s.scrollIntoView({behavior:"smooth"})},[h]);const $=async s=>{try{const c=await k(),r=s.toLowerCase();if(r.includes("مبيعات")||r.includes("إيرادات")||r.includes("اليوم")){const n=new Date().toISOString().slice(0,10),a=await c.selectFrom("orders").select([c.fn.count("id").as("count"),c.fn.sum("total_cents").as("total")]).where("status","=","PAID").where("created_at",">=",n).executeTakeFirst(),t=(a==null?void 0:a.total)??0,l=(a==null?void 0:a.count)??0,i=l>0?t/l:0;return`📊 **ملخص مبيعات اليوم (${n})**

• إجمالي المبيعات: ${u(t)}
• عدد الطلبات: ${l}
• متوسط قيمة الطلب: ${u(i)}
• الوقت: ${new Date().toLocaleTimeString("ar-SA")}`}if(r.includes("مخزون")||r.includes("منخفض")){const n=await c.selectFrom("ingredients").selectAll().where("is_active","=",1).where("current_stock","<",c.dynamic.ref("min_stock")).orderBy("current_stock","asc").execute();if(n.length===0)return"✅ جميع المواد ضمن الحد الآمن. المخزون بحالة ممتازة.";let a=`⚠️ **المواد منخفضة المخزون (${n.length})**

`;for(const t of n)a+=`• ${t.name}: المخزون ${t.current_stock} / الحد الأدنى ${t.min_stock} ${t.unit}
`;return a}if(r.includes("حضور")||r.includes("موظف")||r.includes("الحاضر")){const n=new Date().toISOString().slice(0,10),a=await c.selectFrom("attendance").innerJoin("users","users.id","attendance.user_id").select(["users.name","attendance.clock_in","attendance.status"]).where("attendance.date","=",n).execute();if(a.length===0)return"👥 لم يسجل أي موظف حضور اليوم بعد.";const t=a.filter(d=>d.status==="PRESENT"||d.status==="LATE"),l=a.filter(d=>d.status==="LATE");let i=`👥 **الحضور اليوم (${n})**

`;i+=`• إجمالي المسجلين: ${a.length}
`,i+=`• الحاضرون: ${t.length}
`,l.length>0&&(i+=`• المتأخرون: ${l.length}

`);for(const d of t)i+=`• ${d.name}: ${R(d.clock_in)}${d.status==="LATE"?" ⚠️ متأخر":""}
`;return i}if(r.includes("طلب")||r.includes("نشط")){const n=await c.selectFrom("orders").leftJoin("tables","tables.id","orders.table_id").select(["orders.id","orders.status","orders.order_type","orders.total_cents","orders.customer_name","tables.name as table_name"]).where("orders.status","in",["PENDING","PREPARING","READY"]).orderBy("orders.created_at","desc").limit(20).execute();if(n.length===0)return"📋 لا توجد طلبات نشطة حالياً.";let a=`📋 **الطلبات النشطة (${n.length})**

`;for(const t of n){const l=t.order_type==="DINE_IN"?"داخلي":t.order_type==="TAKEAWAY"?"طلبية خارجية":"توصيل";a+=`• #${t.id.slice(0,6)} | ${t.table_name??t.customer_name??"—"} | ${l} | ${u(t.total_cents)} | ${t.status==="PENDING"?"قيد الانتظار":t.status==="PREPARING"?"قيد التحضير":"جاهز"}
`}return a}if(r.includes("أفضل")||r.includes("مبيع")||r.includes("الأصناف")){const n=await c.selectFrom("order_items").innerJoin("menu_items","menu_items.id","order_items.menu_item_id").select(["menu_items.name",N`SUM(order_items.quantity)`.as("total_qty"),N`SUM(order_items.quantity * order_items.unit_price_cents)`.as("total_revenue")]).groupBy("menu_items.name").orderBy("total_qty","desc").limit(10).execute();if(n.length===0)return"🏆 لا توجد بيانات مبيعات كافية للتحليل.";let a=`🏆 **أفضل الأصناف مبيعاً**

`;return n.forEach((t,l)=>{a+=`${l+1}. ${t.name}: ${t.total_qty} وحدة | ${u(t.total_revenue??0)}
`}),a}if(r.includes("ديون")||r.includes("مستحقات")){const n=await c.selectFrom("debtors").selectAll().where("is_active","=",1).where("balance_cents",">",0).orderBy("balance_cents","desc").limit(10).execute();if(n.length===0)return"💳 لا توجد ديون مستحقة. جميع الحسابات مسددة.";const a=n.reduce((l,i)=>l+i.balance_cents,0);let t=`💳 **الديون المستحقة (${n.length} عميل)**

`;t+=`إجمالي الديون: ${u(a)}

`;for(const l of n)t+=`• ${l.name}: ${u(l.balance_cents)}
`;return t}return`عذراً، لم أتمكن من فهم طلبك. يرجى اختيار أحد الخيارات السريعة أدناه أو إعادة صياغة السؤال.

الخيارات المتاحة:
• مبيعات اليوم
• المخزون المنخفض
• حضور الموظفين
• الطلبات النشطة
• أفضل الأصناف مبيعاً
• الديون المستحقة`}catch{return"حدث خطأ أثناء تنفيذ الاستعلام. يرجى المحاولة مرة أخرى."}},b=async s=>{const c=(s||f).trim();if(!c||p)return;const r={id:crypto.randomUUID(),role:"user",content:c,timestamp:new Date().toISOString()};y(t=>[...t,r]),g(""),w(!0);const n=await $(c),a={id:crypto.randomUUID(),role:"assistant",content:n,timestamp:new Date().toISOString()};y(t=>[...t,a]),w(!1)};return(o==null?void 0:o.role)!=="OWNER"?e.jsx("div",{className:"p-6 h-full flex items-center justify-center",dir:"rtl",children:e.jsxs("div",{className:"text-center space-y-4",children:[e.jsx(x,{className:"w-16 h-16 mx-auto text-slate-300"}),e.jsx("h1",{className:"text-xl font-bold text-slate-900",children:"المساعد الذكي"}),e.jsx("p",{className:"text-slate-500 font-arabic",children:"هذه الميزة متاحة فقط لصاحب المنشأة. يرجى تسجيل الدخول بحساب المالك."})]})}):e.jsxs("div",{className:"h-full flex flex-col",dir:"rtl",children:[e.jsxs("div",{className:"bg-emerald-600 text-white px-6 py-4 flex items-center gap-3",children:[e.jsx(x,{className:"w-6 h-6"}),e.jsxs("div",{children:[e.jsx("h1",{className:"font-bold",children:"المساعد الذكي للمطعم"}),e.jsx("p",{className:"text-emerald-100 text-xs",children:"مدعوم بالذكاء الاصطناعي - إصدار المالك"})]}),e.jsxs("div",{className:"mr-auto flex items-center gap-1 bg-emerald-500/30 px-3 py-1 rounded-full text-xs",children:[e.jsx(E,{className:"w-3 h-3"}),e.jsx("span",{children:"مميز"})]})]}),e.jsxs("div",{className:"flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50",children:[h.map(s=>e.jsxs("div",{className:`flex gap-3 ${s.role==="user"?"justify-start flex-row-reverse":""}`,children:[e.jsx("div",{className:`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${s.role==="assistant"?"bg-emerald-100 text-emerald-600":"bg-indigo-100 text-indigo-600"}`,children:s.role==="assistant"?e.jsx(x,{className:"w-4 h-4"}):e.jsx(S,{className:"w-4 h-4"})}),e.jsxs("div",{className:`max-w-[80%] rounded-2xl p-4 text-sm leading-relaxed ${s.role==="assistant"?"bg-white shadow-sm text-slate-900":"bg-emerald-600 text-white"}`,children:[e.jsx("div",{className:"whitespace-pre-wrap font-arabic",children:s.content}),e.jsx("p",{className:`text-xs mt-2 ${s.role==="assistant"?"text-slate-400":"text-emerald-200"}`,children:new Date(s.timestamp).toLocaleTimeString("ar-SA",{hour:"2-digit",minute:"2-digit"})})]})]},s.id)),p&&e.jsxs("div",{className:"flex gap-3",children:[e.jsx("div",{className:"w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center",children:e.jsx(x,{className:"w-4 h-4"})}),e.jsx("div",{className:"bg-white rounded-2xl p-4 shadow-sm",children:e.jsxs("div",{className:"flex gap-1",children:[e.jsx("span",{className:"w-2 h-2 bg-emerald-400 rounded-full animate-bounce",style:{animationDelay:"0ms"}}),e.jsx("span",{className:"w-2 h-2 bg-emerald-400 rounded-full animate-bounce",style:{animationDelay:"150ms"}}),e.jsx("span",{className:"w-2 h-2 bg-emerald-400 rounded-full animate-bounce",style:{animationDelay:"300ms"}})]})})]}),e.jsx("div",{ref:j})]}),h.length<=2&&e.jsxs("div",{className:"px-4 pb-2",children:[e.jsx("p",{className:"text-xs text-slate-400 font-arabic mb-2 text-center",children:"أسئلة سريعة"}),e.jsx("div",{className:"flex flex-wrap gap-2 justify-center",children:q.map(s=>e.jsxs("button",{onClick:()=>b(s.query),className:"px-4 py-2 rounded-xl bg-white border border-slate-200 text-sm text-slate-700 font-arabic hover:border-emerald-300 hover:text-emerald-600 transition-colors shadow-sm",children:[s.icon," ",s.label]},s.label))})]}),e.jsx("div",{className:"border-t border-slate-200 bg-white p-4",children:e.jsxs("div",{className:"flex gap-2 max-w-4xl mx-auto",children:[e.jsx("input",{type:"text",value:f,onChange:s=>g(s.target.value),onKeyDown:s=>s.key==="Enter"&&b(),placeholder:"اسأل عن المبيعات، المخزون، الموظفين...",className:"flex-1 h-12 px-4 rounded-xl bg-white border border-slate-200 text-sm outline-none focus:border-emerald-500 font-arabic"}),e.jsx("button",{onClick:()=>b(),disabled:!f.trim()||p,className:"h-12 w-12 rounded-xl bg-emerald-600 text-white flex items-center justify-center hover:bg-emerald-700 transition-colors disabled:opacity-40",children:e.jsx(A,{className:"w-5 h-5"})})]})})]})}export{M as default};
