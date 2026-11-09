import { useEffect, useState } from "react";
import { usePrefsStore } from "../../stores/prefsStore";
import { useMenuStore } from "../../stores/menuStore";
import ProductsPerRowSetting from "./ProductsPerRowSetting";
import { getHistoryAccess, saveHistoryAccess, type HistoryAccess } from "../../lib/orderHistory";
import { realErrorText } from "../../lib/errors";
import {
  PICKUP_CHOICE_MINUTES,
  QUANTITY_STEPS,
  pickupChoiceLabel,
  type DeliveryCardSize,
  type OrderPanelSize,
  type PriceEditMode,
} from "../../lib/prefs";

/**
 * Settings > التفضيلات والتصميم: every size, shortcut and question of the till
 * in one place. Sizes are tiles (like "products per row"), behaviours are
 * switches. All of it is per device (see lib/prefs.ts).
 */

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-md p-5 border border-ink-200 space-y-4">
      <div>
        <span className="text-sm font-arabic text-ink-900 block">{title}</span>
        {hint && <span className="text-xs font-arabic text-ink-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onChange, label, hint, testid }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; testid: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <span className="text-sm font-arabic text-ink-900 block">{label}</span>
        {hint && <span className="text-xs font-arabic text-ink-400">{hint}</span>}
      </div>
      <button
        dir="ltr"
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        data-testid={testid}
        onClick={() => onChange(!on)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? "bg-saffron-600" : "bg-ink-300"}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
      </button>
    </div>
  );
}

function Tiles<T extends string | number>({
  value, options, onChange, testid, label,
}: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; testid: string; label: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`${testid}-${o.value}`}
            onClick={() => onChange(o.value)}
            className={`h-10 px-4 rounded-sm border-2 text-sm font-arabic transition-colors ${
              active ? "border-saffron-600 bg-saffron-50 text-saffron-600 font-bold" : "border-ink-200 text-ink-700 hover:border-saffron-400"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const PANEL_SIZES: { value: OrderPanelSize; label: string; rows: number }[] = [
  { value: "comfortable", label: "مريح", rows: 3 },
  { value: "compact", label: "مضغوط", rows: 5 },
  { value: "tiny", label: "صغير جداً", rows: 8 },
];
const CARD_SIZES: { value: DeliveryCardSize; label: string; cols: number }[] = [
  { value: "large", label: "كبيرة", cols: 2 },
  { value: "medium", label: "متوسطة", cols: 3 },
  { value: "small", label: "صغيرة", cols: 5 },
];
const PRICE_MODES: { value: PriceEditMode; label: string }[] = [
  { value: "off", label: "ممنوع" },
  { value: "manager", label: "المدير فقط" },
  { value: "everyone", label: "كل الموظفين" },
];

export default function PreferencesTab() {
  const p = usePrefsStore();
  const categories = useMenuStore((s) => s.categories);
  const loadMenu = useMenuStore((s) => s.fetchMenu);
  const [rateText, setRateText] = useState(p.usdRate ? String(p.usdRate) : "");
  const [labelText, setLabelText] = useState(p.drinkLabel);
  // Kept on the server (the till enforces it for every cashier), unlike the rest of this page.
  const [access, setAccess] = useState<HistoryAccess | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  useEffect(() => {
    getHistoryAccess().then(setAccess).catch(() => setAccess(null));
  }, []);
  const changeAccess = async (next: HistoryAccess) => {
    const before = access;
    setAccess(next);
    setAccessError(null);
    try {
      await saveHistoryAccess(next);
    } catch (e) {
      setAccess(before);
      setAccessError(realErrorText(e));
    }
  };

  useEffect(() => {
    if (categories.length === 0) void loadMenu?.();
  }, [categories.length, loadMenu]);

  const togglePickup = (m: number) => {
    const has = p.pickupChoices.includes(m);
    p.setPref("pickupChoices", has ? p.pickupChoices.filter((x) => x !== m) : [...p.pickupChoices, m]);
  };
  const toggleDrinkCategory = (name: string) => {
    const has = p.drinkCategories.includes(name);
    p.setPref("drinkCategories", has ? p.drinkCategories.filter((x) => x !== name) : [...p.drinkCategories, name]);
  };

  return (
    <div className="space-y-6 max-w-xl" data-testid="prefs-tab">
      <div>
        <h2 className="text-lg font-bold text-ink-900 font-arabic">التفضيلات والتصميم</h2>
        <p className="text-xs text-ink-500 font-arabic mt-1">
          كل ما هنا تختاره أنت حسب طريقة عملك. يُحفظ لهذا الجهاز فقط، فيمكن لكل صندوق أن يختلف عن الآخر.
        </p>
      </div>

      <h3 className="text-base font-bold text-ink-900 font-arabic">أحجام الشاشة</h3>
      <ProductsPerRowSetting />

      <Card title="حجم قائمة الطلب (الجانب)" hint="اختر «مضغوط» أو «صغير جداً» لتظهر الطلبية الطويلة كاملة دون تمرير">
        <Tiles value={p.orderPanelSize} options={PANEL_SIZES} onChange={(v) => p.setPref("orderPanelSize", v)} testid="pref-panel" label="حجم قائمة الطلب" />
        <div className="rounded-sm bg-ink-50 border border-ink-200 p-2 space-y-1" aria-hidden="true">
          {Array.from({ length: PANEL_SIZES.find((s) => s.value === p.orderPanelSize)?.rows ?? 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 rounded-[4px] bg-white border border-ink-200 px-2" style={{ height: p.orderPanelSize === "comfortable" ? 22 : p.orderPanelSize === "compact" ? 14 : 9 }}>
              <div className="h-1 w-1/2 rounded-full bg-ink-200" />
              <div className="h-1 w-6 rounded-full bg-saffron-300 me-auto" />
            </div>
          ))}
        </div>
      </Card>

      <Card title="حجم بطاقات الطلبات في صفحة التوصيل" hint="الأصغر يُظهر طلبات أكثر معاً؛ الضغط على البطاقة يفتح التفاصيل في لوحة جانبية">
        <Tiles value={p.deliveryCardSize} options={CARD_SIZES} onChange={(v) => p.setPref("deliveryCardSize", v)} testid="pref-delivery" label="حجم بطاقات التوصيل" />
        <div className="rounded-sm bg-ink-50 border border-ink-200 p-2" aria-hidden="true">
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${CARD_SIZES.find((s) => s.value === p.deliveryCardSize)?.cols ?? 2}, minmax(0, 1fr))` }}>
            {Array.from({ length: (CARD_SIZES.find((s) => s.value === p.deliveryCardSize)?.cols ?? 2) * 2 }, (_, i) => (
              <div key={i} className="rounded-[4px] bg-white border border-ink-200 p-1 space-y-1">
                <div className="h-1 w-2/3 rounded-full bg-ink-200" />
                <div className="h-1 w-1/3 rounded-full bg-saffron-300" />
              </div>
            ))}
          </div>
        </div>
      </Card>

      <h3 className="text-base font-bold text-ink-900 font-arabic">سرعة العمل على الصندوق</h3>

      <Card title="شكل الإضافات (بدون / مع)" hint="«قائمة»: كل الخيارات أزرار مرة واحدة. «جدول»: زرّان كبيران «بدون» و«مع»، تضغط أحدهما فتظهر خياراته فقط (للأصناف الكثيرة الإضافات).">
        <Tiles
          value={p.optionsLayout}
          options={[{ value: "list" as const, label: "قائمة" }, { value: "table" as const, label: "جدول بدون / مع" }]}
          onChange={(v) => p.setPref("optionsLayout", v)}
          testid="pref-options-layout"
          label="شكل الإضافات"
        />
      </Card>

      <Card title="الكمية" hint="لطلب 10 برغر لا داعي للضغط على + عشر مرات">
        <Switch on={p.quantityTyping} onChange={(v) => p.setPref("quantityTyping", v)} label="اكتب الكمية بلوحة المفاتيح" hint="اضغط على رقم الكمية في الطلب واكتب العدد ثم Enter" testid="pref-qty-typing" />
        <div>
          <span className="text-xs font-arabic text-ink-500 block mb-1.5">زر زيادة سريعة بجانب (+)</span>
          <Tiles
            value={p.quantityStep}
            options={QUANTITY_STEPS.map((n) => ({ value: n as number, label: n === 0 ? "بدون" : `+${n}` }))}
            onChange={(v) => p.setPref("quantityStep", v)}
            testid="pref-qty-step"
            label="زر الزيادة السريعة"
          />
        </div>
      </Card>

      <Card title="الاستلام (السفري)" hint="الأزرار التي تظهر عند أخذ طلب سيأتي الزبون لاستلامه">
        <div className="flex flex-wrap gap-1.5">
          {PICKUP_CHOICE_MINUTES.map((m) => {
            const on = p.pickupChoices.includes(m);
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                data-testid={`pref-pickup-${m}`}
                onClick={() => togglePickup(m)}
                className={`h-10 px-3 rounded-sm border-2 text-sm font-arabic ${on ? "border-saffron-600 bg-saffron-50 text-saffron-600 font-bold" : "border-ink-200 text-ink-500 hover:border-saffron-400"}`}
              >
                {pickupChoiceLabel(m)}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-ink-500 font-arabic">«فوراً» يطبع الطلب في المطبخ مباشرة دون إدخال أي وقت.</p>
        <Switch on={p.pickupNameRequired} onChange={(v) => p.setPref("pickupNameRequired", v)} label="اسم الزبون إلزامي" hint="عند الإيقاف يُستعمل «زبون» إن لم يُكتب اسم" testid="pref-pickup-name" />
      </Card>

      <h3 className="text-base font-bold text-ink-900 font-arabic">الأسئلة والصلاحيات</h3>

      <Card title="الإلغاء" hint="للمطاعم المزدحمة: أوقف الأسئلة التي تأخذ وقتاً">
        <Switch on={p.askVoidReason} onChange={(v) => p.setPref("askVoidReason", v)} label="اسأل عن سبب حذف صنف" hint="عند الإيقاف يُحذف الصنف بنقرة. إذن المدير للمبالغ الكبيرة يبقى كما حدده المالك" testid="pref-ask-void" />
        <Switch on={p.askCancelOrderReason} onChange={(v) => p.setPref("askCancelOrderReason", v)} label="اسأل عن سبب إلغاء الطلب كاملاً" testid="pref-ask-cancel" />
        <Switch on={p.confirmCancelOrder} onChange={(v) => p.setPref("confirmCancelOrder", v)} label="اطلب تأكيداً قبل إلغاء الطلب كاملاً" testid="pref-confirm-cancel" />
      </Card>

      <Card title="الدفع" hint="للمطاعم المزدحمة: زر «دفع» ينهي البيع فوراً دون شاشة اختيار الطريقة والآلة الحاسبة">
        <Switch on={p.skipPaymentScreen} onChange={(v) => p.setPref("skipPaymentScreen", v)} label="ادفع مباشرة بدون شاشة الدفع" hint="يُسجَّل البيع نقداً بالمبلغ بالضبط (بدون باقٍ) ويُفتح الدرج ويُطبع الإيصال. الدفع بالبطاقة أو الدين يحتاج إيقاف هذا الخيار. الفواتير الآجلة (الدين) تبقى تفتح شاشتها" testid="pref-skip-payment" />
      </Card>

      <Card title="تغيير سعر صنف في الطلب" hint="لصديق أو زبون خاص: زر «السعر» يظهر على كل سطر. كل تغيير يُسجَّل باسم من فعله">
        <Tiles value={p.priceEdit} options={PRICE_MODES} onChange={(v) => p.setPref("priceEdit", v)} testid="pref-price" label="من يغيّر السعر" />
      </Card>

      <h3 className="text-base font-bold text-ink-900 font-arabic">الفاتورة</h3>

      <Card title="كلمة عامة للمشروبات في الفاتورة" hint="تُكتب «مشروب ×2» بدل اسم المشروب، والسعر يبقى سعر المشروب الحقيقي">
        <Switch on={p.drinkLabelOn} onChange={(v) => p.setPref("drinkLabelOn", v)} label="فعّل الكلمة العامة" testid="pref-drink-on" />
        {p.drinkLabelOn && (
          <>
            <div>
              <label className="text-xs font-arabic text-ink-500 block mb-1">الكلمة</label>
              <input
                value={labelText}
                onChange={(e) => setLabelText(e.target.value)}
                onBlur={() => p.setPref("drinkLabel", labelText)}
                data-testid="pref-drink-label"
                className="h-10 w-48 rounded-sm border-2 border-ink-200 px-3 font-arabic text-sm outline-none focus:border-saffron-600"
              />
            </div>
            <div>
              <span className="text-xs font-arabic text-ink-500 block mb-1.5">الفئات التي تُكتب بهذه الكلمة</span>
              <div className="flex flex-wrap gap-1.5">
                {categories.length === 0 && <span className="text-xs text-ink-400 font-arabic">لا توجد فئات بعد</span>}
                {categories.map((c) => {
                  const on = p.drinkCategories.includes(c.name);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      data-testid={`pref-drink-cat-${c.id}`}
                      onClick={() => toggleDrinkCategory(c.name)}
                      className={`h-9 px-3 rounded-sm border-2 text-sm font-arabic ${on ? "border-saffron-600 bg-saffron-50 text-saffron-600 font-bold" : "border-ink-200 text-ink-500 hover:border-saffron-400"}`}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </Card>

      {access && (
        <Card title="سجل الطلبات للكاشير" hint="المدير والمالك يريان كل الأيام دائماً. هنا تحدد إلى أي يوم يرجع الكاشير ليعيد طباعة فاتورة قديمة (بتاريخها الأصلي). يُطبَّق على كل الصناديق.">
          <Tiles
            value={access.cashier_history_days}
            options={[
              { value: 0, label: "اليوم فقط" },
              { value: 1, label: "حتى أمس" },
              { value: 7, label: "7 أيام" },
              { value: 30, label: "30 يوماً" },
              { value: 90, label: "90 يوماً" },
            ]}
            onChange={(v) => void changeAccess({ ...access, cashier_history_days: v })}
            testid="pref-history-days"
            label="أيام سجل الكاشير"
          />
          <Switch on={access.cashier_sees_all} onChange={(v) => void changeAccess({ ...access, cashier_sees_all: v })} label="يرى الكاشير طلبات بقية الموظفين أيضاً" hint="وإلا يرى طلباته هو فقط" testid="pref-history-all" />
          {accessError && <p className="text-xs text-danger font-arabic">{accessError}</p>}
        </Card>
      )}

      <Card title="إعادة طباعة فاتورة قديمة">
        <Switch on={p.reprintCopyMark} onChange={(v) => p.setPref("reprintCopyMark", v)} label="اكتب «نسخة» أعلى الفاتورة المعاد طباعتها" hint="التاريخ والأرقام تبقى كما في الفاتورة الأصلية" testid="pref-copy-mark" />
      </Card>

      <h3 className="text-base font-bold text-ink-900 font-arabic">الأسعار بالدولار</h3>
      <Card title="سعر الصرف" hint="المشتريات من الموردين بالدولار: اكتب كم تساوي 1$ بعملة المحل، فتظهر خانة «$» عند إدخال التكلفة وتتحول لعملة المحل تلقائياً">
        <input
          value={rateText}
          inputMode="decimal"
          placeholder="مثال: 15000"
          onChange={(e) => setRateText(e.target.value)}
          onBlur={() => {
            const n = Number(rateText.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)));
            p.setPref("usdRate", Number.isFinite(n) && n > 0 ? n : 0);
            if (!(Number.isFinite(n) && n > 0)) setRateText("");
          }}
          data-testid="pref-usd-rate"
          dir="ltr"
          className="h-10 w-48 rounded-sm border-2 border-ink-200 px-3 text-sm outline-none focus:border-saffron-600"
        />
        <p className="text-[11px] text-ink-500 font-arabic">اتركه فارغاً لإخفاء خانة الدولار. غيّره كلما تغيّر السعر؛ تكاليف المنتجات المحفوظة سابقاً لا تتغير.</p>
      </Card>

      <h3 className="text-base font-bold text-ink-900 font-arabic">السوق (WENZDES Marketplace)</h3>
      <Card title="ربط المخزون مع السوق" hint="يعمل على الجهاز الرئيسي للمدير أو المالك كل دقيقتين. الحالات غير الواضحة تبقى للمراجعة وتظهر في الجرس.">
        <Switch on={p.marketAutoReceive} onChange={(v) => p.setPref("marketAutoReceive", v)} label="أضف بضاعة طلباتي من السوق للمخزون تلقائياً" hint="فقط عندما يكون كل صنف في الطلبية مطابقاً بوضوح لمادة أو منتج عندك" testid="pref-market-receive" />
        <Switch on={p.marketAutoApply} onChange={(v) => p.setPref("marketAutoApply", v)} label="اخصم طلبات عملائي من المخزون تلقائياً (للمورّد)" hint="عندما تقبل طلباً وكل منتجاته مربوطة بمنتجات عندك" testid="pref-market-apply" />
      </Card>

      <h3 className="text-base font-bold text-ink-900 font-arabic">التنبيهات داخل التطبيق</h3>
      <Card title="ما الذي ينبهك به الجرس؟" hint="الجرس أعلى الشاشة يجمع التنبيهات">
        <Switch on={p.notifyLowStock} onChange={(v) => p.setPref("notifyLowStock", v)} label="منتج أوشك على النفاد" testid="pref-notify-low" />
        <Switch on={p.notifyLongShift} onChange={(v) => p.setPref("notifyLongShift", v)} label="وردية مفتوحة منذ وقت طويل" testid="pref-notify-shift" />
      </Card>
    </div>
  );
}
