import { useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import type { ShopSettings } from "../../lib/shop";
import { ChoiceCards, Field, Hint, btnPrimary, inputCls } from "../payroll/ui";

/**
 * Barcode and shop settings: whether a deli/produce scale's labels are read (and how), and whether the till
 * refuses to complete a sale that the tracked stock cannot cover.
 */
export default function SettingsTab() {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [s, setS] = useState<ShopSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<ShopSettings>("get_retail_settings_v3", { sessionToken: token }).then(setS).catch((err) => toast.error(realErrorText(err)));
  }, [token, toast]);

  if (!s) return <p className="text-ink-500 font-arabic">جاري التحميل...</p>;
  const patch = (p: Partial<ShopSettings>) => setS({ ...s, ...p });
  const scaleOn = s.scale_prefix !== "";
  const used = s.scale_prefix.length + s.scale_plu_digits + s.scale_value_digits;

  const save = async () => {
    setBusy(true);
    try {
      await invoke("save_retail_settings_v3", { sessionToken: token, settings: s });
      toast.success("تم حفظ الإعدادات");
    } catch (err) {
      toast.error(realErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl" data-testid="settings-tab">
      <section className="zc-card p-5 space-y-3">
        <h2 className="font-bold font-arabic text-ink-900">ميزان بباركود (جبنة، لحمة، خضار)</h2>
        <Hint summary="بعض الموازين تطبع ملصقاً بباركود فيه رقم الصنف والوزن (أو السعر). إن فعّلت هذا تقرؤه الكاشيرة بالمسح فيُضاف الصنف بوزنه.">
          <p>مثال لباركود من 13 رقماً: أول رقم «2» (البادئة)، ثم 6 أرقام لرمز الصنف، ثم 5 أرقام للوزن بالغرام، ثم رقم تحقق.</p>
          <p><b>رمز الصنف</b> هو الباركود الذي تضعه للمنتج في صفحة المنتجات (مثلاً 123 أو 000123، الأصفار في البداية لا تهم). يجب أن يكون المنتج «يُباع بالوزن».</p>
          <p>اسأل مورد الميزان عن تنسيق ملصقاته. اترك البادئة فارغة إن كنت لا تستعمل ميزاناً بباركود.</p>
        </Hint>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="بادئة الباركود (فارغ = معطّل)" hint="عادةً 2 أو 20 إلى 28."><input value={s.scale_prefix} onChange={(e) => patch({ scale_prefix: e.target.value.replace(/\D/g, "").slice(0, 4) })} className={inputCls} dir="ltr" data-testid="scale-prefix" /></Field>
          <Field label="خانات رمز الصنف"><input type="number" min={1} max={8} value={s.scale_plu_digits} onChange={(e) => patch({ scale_plu_digits: Number(e.target.value) || 6 })} className={inputCls} dir="ltr" data-testid="scale-plu" /></Field>
          <Field label="خانات الوزن أو السعر"><input type="number" min={1} max={8} value={s.scale_value_digits} onChange={(e) => patch({ scale_value_digits: Number(e.target.value) || 5 })} className={inputCls} dir="ltr" data-testid="scale-value" /></Field>
        </div>
        {scaleOn && (
          <>
            <ChoiceCards<ShopSettings["scale_value_kind"]>
              testId="scale-kind"
              value={s.scale_value_kind}
              onChange={(v) => patch({ scale_value_kind: v })}
              options={[
                { value: "WEIGHT_G", title: "الرقم الأخير هو الوزن بالغرام", text: "النظام يحسب السعر من سعر الكيلوغرام عندك." },
                { value: "PRICE", title: "الرقم الأخير هو المبلغ المطلوب", text: "الميزان حسب السعر، والنظام يدخل المبلغ كما طبعه الميزان ويحسب الوزن منه." },
              ]}
            />
            <p className={`text-xs font-arabic ${used > 12 ? "text-danger" : "text-ink-500"}`}>
              البادئة + رمز الصنف + القيمة = {used} من 12 خانة (الخانة 13 للتحقق).{used !== 12 && used <= 12 ? " إن كان باركود ميزانك 13 رقماً فالمجموع يجب أن يكون 12." : ""}
            </p>
          </>
        )}
      </section>

      <section className="zc-card p-5 space-y-3">
        <h2 className="font-bold font-arabic text-ink-900">عند نفاد المخزون</h2>
        <label className="flex items-start gap-2 font-arabic text-sm text-ink-900">
          <input type="checkbox" checked={s.block_sale_when_empty} onChange={(e) => patch({ block_sale_when_empty: e.target.checked })} className="mt-1" data-testid="block-empty" />
          <span>
            امنع إتمام البيع إن لم يكفِ مخزون منتج مُتتبَّع
            <span className="block text-xs text-ink-400">مغلق افتراضياً: يستمر البيع ويظهر تنبيه فقط، لأن البضاعة قد تكون وصلت ولم تُسجَّل. فعّله إن كان مخزونك دقيقاً ولا تريد بيع ما ليس عندك.</span>
          </span>
        </label>
      </section>

      <div className="flex justify-end"><button onClick={save} disabled={busy} className={btnPrimary} data-testid="settings-save">{busy ? "جاري الحفظ..." : "حفظ"}</button></div>
    </div>
  );
}
