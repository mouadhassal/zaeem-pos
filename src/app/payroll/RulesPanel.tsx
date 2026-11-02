import { useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import {
  WEEKDAYS,
  exampleLines,
  type AbsenceRule,
  type EarlyRule,
  type LateRule,
  type LateTier,
  type ManagerAccess,
  type OvertimeRule,
  type PayrollSettings,
} from "../../lib/payroll";
import { ChoiceCards, Field, Hint, btnGhost, btnPrimary, inputCls } from "./ui";

interface AttendanceSettings {
  shift_start: string;
  late_grace_minutes: number;
  min_gap_seconds: number;
}

interface Props {
  settings: PayrollSettings;
  /** First-time setup: one question at a time with Next/Back. After that, every question on one page. */
  wizard: boolean;
  onSaved: (s: PayrollSettings) => void;
}

const STEP_TITLES = ["أيام العمل والدوام", "التأخير", "الغياب", "الخروج المبكر والوقت الإضافي", "صلاحية المشرفين", "المراجعة والحفظ"];

/**
 * The owner's payroll rules. Nothing is deducted until he chooses here, every choice says in plain words
 * what it does, and a worked example on a sample salary shows the money each rule would take or add.
 */
export default function RulesPanel({ settings, wizard, onSaved }: Props) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [s, setS] = useState<PayrollSettings>(settings);
  const [att, setAtt] = useState<AttendanceSettings>({ shift_start: "09:00", late_grace_minutes: 10, min_gap_seconds: 60 });
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [sample, setSample] = useState("780000");
  const [fixedLate, setFixedLate] = useState(String(settings.late_fixed_cents || ""));
  const [fixedAbsence, setFixedAbsence] = useState(String(settings.absence_fixed_cents || ""));

  useEffect(() => {
    invoke<AttendanceSettings>("get_attendance_settings_v3", { sessionToken: token }).then(setAtt).catch(() => {});
  }, [token]);

  const patch = (p: Partial<PayrollSettings>) => setS((prev) => ({ ...prev, ...p }));
  const sampleSalary = Math.max(1, parseMoneyInput(sample) || 780_000);
  // The examples use what is typed now, not only what is saved.
  const live: PayrollSettings = { ...s, late_fixed_cents: parseMoneyInput(fixedLate) || 0, absence_fixed_cents: parseMoneyInput(fixedAbsence) || 0 };

  const toggleOffDay = (d: number) =>
    patch({ weekly_off_days: s.weekly_off_days.includes(d) ? s.weekly_off_days.filter((x) => x !== d) : [...s.weekly_off_days, d].sort() });

  const setTier = (i: number, t: Partial<LateTier>) => patch({ late_tiers: s.late_tiers.map((x, j) => (j === i ? { ...x, ...t } : x)) });

  const save = async () => {
    setSaving(true);
    try {
      const toSave: PayrollSettings = { ...live, configured: true };
      await invoke("set_attendance_settings_v3", { sessionToken: token, shiftStart: att.shift_start, lateGraceMinutes: att.late_grace_minutes });
      await invoke("save_payroll_settings_v3", { sessionToken: token, settings: toSave });
      toast.success("تم حفظ قواعد الرواتب");
      onSaved(toSave);
    } catch (err) {
      toast.error(`تعذر الحفظ: ${realErrorText(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const sections: React.ReactNode[] = [
    // 0 -- working days and the shift
    <div key="days" className="space-y-4" data-testid="rules-days">
      <Hint summary="أولاً: متى يعمل فريقك؟ هذا أساس حساب الغياب وأجر اليوم.">
        <p>أيام العطلة الأسبوعية لا تُعدّ غياباً. إن عمل أحدهم في يوم عطلة يُحسب وقته وقتاً إضافياً (إن فعّلت الوقت الإضافي).</p>
      </Hint>
      <Field label="أيام العطلة الأسبوعية">
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((name, d) => (
            <button
              type="button"
              key={d}
              onClick={() => toggleOffDay(d)}
              data-testid={`off-day-${d}`}
              className={`px-3 h-9 rounded-sm text-sm font-arabic border ${s.weekly_off_days.includes(d) ? "bg-saffron-600 text-white border-saffron-600" : "bg-white text-ink-700 border-ink-200"}`}
            >
              {name}
            </button>
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="بداية الدوام" hint="لكل موظف يمكنك تحديد بداية مختلفة من تبويب «الموظفون».">
          <input type="time" value={att.shift_start} onChange={(e) => setAtt({ ...att, shift_start: e.target.value })} className={inputCls} dir="ltr" data-testid="shift-start" />
        </Field>
        <Field label="طول الدوام بالساعات" hint="مثلاً 8 ساعات.">
          <input type="number" min={1} max={18} step={0.5} value={s.shift_minutes / 60} onChange={(e) => patch({ shift_minutes: Math.round((Number(e.target.value) || 8) * 60) })} className={inputCls} dir="ltr" data-testid="shift-hours" />
        </Field>
        <Field label="أيام العمل في الشهر" hint="يُقسم عليها الراتب الشهري ليعطي أجر اليوم (الشائع 26).">
          <input type="number" min={1} max={31} value={s.days_per_month} onChange={(e) => patch({ days_per_month: Number(e.target.value) || 26 })} className={inputCls} dir="ltr" data-testid="days-per-month" />
        </Field>
      </div>
    </div>,

    // 1 -- lateness
    <div key="late" className="space-y-4" data-testid="rules-late">
      <Hint summary="ماذا يحدث إن تأخر موظف عن بداية الدوام؟ أنت تقرر.">
        <p>المهلة تعني الدقائق المسموحة بلا أي خصم. إن تأخر أقل منها لا يُعدّ متأخراً.</p>
        <p>يحسب النظام التأخير من أول بصمة دخول في اليوم مقابل بداية الدوام.</p>
      </Hint>
      <Field label="مهلة التأخير بالدقائق" hint="مثلاً 10: من وصل 9:08 والدوام 9:00 لا يُخصم منه شيء.">
        <input type="number" min={0} max={180} value={att.late_grace_minutes} onChange={(e) => setAtt({ ...att, late_grace_minutes: Number(e.target.value) || 0 })} className={`${inputCls} max-w-[140px]`} dir="ltr" data-testid="grace" />
      </Field>
      <ChoiceCards<LateRule>
        testId="late-rule"
        value={s.late_rule}
        onChange={(v) => patch({ late_rule: v, late_tiers: v === "TIERS" && s.late_tiers.length === 0 ? [{ from_minutes: 15, day_pct: 25 }, { from_minutes: 60, day_pct: 100 }] : s.late_tiers })}
        options={[
          { value: "NONE", title: "لا خصم على التأخير", text: "يُسجَّل التأخير في الكشف للمعلومة فقط." },
          { value: "PER_MINUTE", title: "خصم بالدقيقة", text: "يُخصم بقدر الوقت الضائع من أجر اليوم. تأخر 20 دقيقة يُخصم منه أجر 20 دقيقة." },
          { value: "FIXED_PER_LATE", title: "مبلغ ثابت لكل يوم تأخير", text: "مهما كان التأخير يُخصم مبلغ واحد تحدده أنت." },
          { value: "TIERS", title: "شرائح", text: "كلما زاد التأخير زاد الخصم. مثال: 15 دقيقة = ربع يوم، ساعة = يوم كامل." },
        ]}
      />
      {s.late_rule === "PER_MINUTE" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="نسبة الخصم من أجر الوقت الضائع %" hint="100 = بقدر الوقت الضائع تماماً. 200 = الضعف.">
            <input type="number" min={0} max={1000} value={s.late_multiplier_pct} onChange={(e) => patch({ late_multiplier_pct: Number(e.target.value) || 0 })} className={inputCls} dir="ltr" data-testid="late-multiplier" />
          </Field>
          <Field label="من أين تُحسب دقائق التأخير؟">
            <select value={s.late_counts_from_start ? "start" : "grace"} onChange={(e) => patch({ late_counts_from_start: e.target.value === "start" })} className={inputCls} data-testid="late-from">
              <option value="start">من بداية الدوام (إن تجاوز المهلة)</option>
              <option value="grace">فقط الدقائق بعد المهلة</option>
            </select>
          </Field>
        </div>
      )}
      {s.late_rule === "FIXED_PER_LATE" && (
        <Field label="المبلغ المخصوم عن كل يوم تأخير">
          <input value={fixedLate} onChange={(e) => setFixedLate(e.target.value)} className={`${inputCls} max-w-[220px]`} dir="ltr" inputMode="numeric" data-testid="late-fixed" />
        </Field>
      )}
      {s.late_rule === "TIERS" && (
        <div className="space-y-2" data-testid="late-tiers">
          <p className="text-xs font-arabic text-ink-500">تُحسب الدقائق من بداية الدوام. الشريحة الأعلى التي بلغها الموظف هي التي تُطبق.</p>
          {s.late_tiers.map((t, i) => (
            <div key={i} className="flex items-center gap-2 font-arabic text-sm">
              <span>من</span>
              <input type="number" min={1} value={t.from_minutes} onChange={(e) => setTier(i, { from_minutes: Number(e.target.value) || 0 })} className={`${inputCls} max-w-[90px]`} dir="ltr" />
              <span>دقيقة: يُخصم</span>
              <input type="number" min={1} max={300} value={t.day_pct} onChange={(e) => setTier(i, { day_pct: Number(e.target.value) || 0 })} className={`${inputCls} max-w-[90px]`} dir="ltr" />
              <span>% من أجر اليوم</span>
              <button type="button" onClick={() => patch({ late_tiers: s.late_tiers.filter((_, j) => j !== i) })} className="text-danger text-xs hover:underline">حذف</button>
            </div>
          ))}
          {s.late_tiers.length < 8 && (
            <button type="button" onClick={() => patch({ late_tiers: [...s.late_tiers, { from_minutes: (s.late_tiers.at(-1)?.from_minutes ?? 0) + 30, day_pct: 50 }] })} className="text-sm text-saffron-600 font-bold font-arabic">+ إضافة شريحة</button>
          )}
        </div>
      )}
    </div>,

    // 2 -- absence
    <div key="absence" className="space-y-4" data-testid="rules-absence">
      <Hint summary="الغياب هو يوم عمل بلا أي بصمة، ولم تسجّل له عذراً مقبولاً.">
        <p>يُحتسب الغياب فقط إن كانت هناك بصمات مسجلة للشهر. إن لم يوجد أي حضور مسجل فلن يُخصم شيء، حتى لا يضيع راتب بسبب نسيان تسجيل الحضور.</p>
        <p>العامل باليوم أو بالساعة لا يُدفع له أصلاً عن اليوم الذي لم يعمله، فلا خصم إضافي عليه. هذه القاعدة للراتب الشهري.</p>
        <p>لأي يوم غاب فيه موظف بعذر، افتح كشفه واضغط «عذر مقبول» على ذلك اليوم.</p>
      </Hint>
      <ChoiceCards<AbsenceRule>
        testId="absence-rule"
        value={s.absence_rule}
        onChange={(v) => patch({ absence_rule: v })}
        options={[
          { value: "NONE", title: "لا خصم على الغياب", text: "يظهر الغياب في الكشف ولا يُخصم." },
          { value: "DAY_PAY", title: "خصم أجر اليوم", text: "يُخصم أجر يوم عن كل غياب. يمكنك جعله يومين مثلاً كعقوبة." },
          { value: "FIXED", title: "مبلغ ثابت لكل غياب", text: "يُخصم مبلغ واحد تحدده عن كل يوم غياب." },
        ]}
      />
      {s.absence_rule === "DAY_PAY" && (
        <Field label="كم يوماً يُخصم عن الغياب؟ (نسبة %)" hint="100 = يوم واحد، 200 = يومان.">
          <input type="number" min={0} max={1000} value={s.absence_multiplier_pct} onChange={(e) => patch({ absence_multiplier_pct: Number(e.target.value) || 0 })} className={`${inputCls} max-w-[140px]`} dir="ltr" data-testid="absence-multiplier" />
        </Field>
      )}
      {s.absence_rule === "FIXED" && (
        <Field label="المبلغ المخصوم عن كل غياب">
          <input value={fixedAbsence} onChange={(e) => setFixedAbsence(e.target.value)} className={`${inputCls} max-w-[220px]`} dir="ltr" inputMode="numeric" data-testid="absence-fixed" />
        </Field>
      )}
    </div>,

    // 3 -- leaving early and overtime
    <div key="early" className="space-y-5" data-testid="rules-early">
      <div className="space-y-3">
        <h3 className="font-bold font-arabic text-ink-900">الخروج قبل نهاية الدوام</h3>
        <Hint summary="يُحسب من آخر بصمة خروج مقابل نهاية الدوام (البداية + طول الدوام)." />
        <ChoiceCards<EarlyRule>
          testId="early-rule"
          value={s.early_rule}
          onChange={(v) => patch({ early_rule: v })}
          options={[
            { value: "NONE", title: "لا خصم", text: "يظهر في الكشف فقط." },
            { value: "PER_MINUTE", title: "خصم بالدقيقة", text: "يُخصم أجر الدقائق التي نقصت من الدوام." },
          ]}
        />
        {s.early_rule === "PER_MINUTE" && (
          <Field label="نسبة الخصم %" hint="100 = بقدر الوقت الناقص.">
            <input type="number" min={0} max={1000} value={s.early_multiplier_pct} onChange={(e) => patch({ early_multiplier_pct: Number(e.target.value) || 0 })} className={`${inputCls} max-w-[140px]`} dir="ltr" />
          </Field>
        )}
      </div>
      <div className="space-y-3">
        <h3 className="font-bold font-arabic text-ink-900">الوقت الإضافي</h3>
        <Hint summary="الوقت الذي يعمله الموظف فوق طول الدوام، وكل عمل في يوم العطلة.">
          <p>مثال: دوام 8 ساعات وعمل 10 ساعات: ساعتان إضافيتان تُدفعان بنسبة تحددها أنت (150% = ساعة ونصف عن كل ساعة).</p>
        </Hint>
        <ChoiceCards<OvertimeRule>
          testId="overtime-rule"
          value={s.overtime_rule}
          onChange={(v) => patch({ overtime_rule: v })}
          options={[
            { value: "NONE", title: "لا وقت إضافي", text: "لا يُدفع شيء فوق الراتب مقابل الساعات الزائدة." },
            { value: "PER_HOUR", title: "يُدفع الوقت الإضافي", text: "يُضاف أجر الوقت الزائد إلى الراتب." },
          ]}
        />
        {s.overtime_rule === "PER_HOUR" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="أجر الوقت الإضافي %" hint="150 = ساعة ونصف عن كل ساعة. 100 = بالأجر العادي.">
              <input type="number" min={100} max={1000} value={s.overtime_multiplier_pct} onChange={(e) => patch({ overtime_multiplier_pct: Number(e.target.value) || 100 })} className={inputCls} dir="ltr" data-testid="overtime-multiplier" />
            </Field>
            <Field label="لا يُحسب إن كان أقل من (دقيقة)" hint="مثلاً 30: من بقي 20 دقيقة زائدة لا يُحسب له وقت إضافي.">
              <input type="number" min={0} max={600} value={s.overtime_after_minutes} onChange={(e) => patch({ overtime_after_minutes: Number(e.target.value) || 0 })} className={inputCls} dir="ltr" />
            </Field>
          </div>
        )}
      </div>
    </div>,

    // 4 -- what managers may do
    <div key="managers" className="space-y-4" data-testid="rules-managers">
      <Hint summary="أنت صاحب القرار: هل يعمل المشرفون في الرواتب، وإلى أي حد؟">
        <p>المشرف يرى فقط موظفي فرعه الأقل منه رتبة (الكاشير والمطبخ). لا يرى راتبك ولا رواتب المشرفين الآخرين ولا راتب نفسه.</p>
        <p>تحديد أجر كل موظف وتغيير هذه القواعد يبقيان لك أنت في كل الأحوال.</p>
        <p>كل ما يفعله المشرف يُسجَّل باسمه في سجل التدقيق.</p>
      </Hint>
      <ChoiceCards<ManagerAccess>
        testId="manager-access"
        value={s.manager_access}
        onChange={(v) => patch({ manager_access: v })}
        options={[
          { value: "NONE", title: "لا وصول للمشرفين", text: "الرواتب لك وحدك. لا تظهر الصفحة للمشرف بشيء." },
          { value: "PREPARE", title: "يجهّز الكشف فقط", text: "يرى كشف موظفيه ويضيف عذراً مقبولاً أو مكافأة أو غرامة أو سلفة أو بصمة منسية. أما الاعتماد والصرف فلك." },
          { value: "FULL", title: "يجهّز ويعتمد ويصرف", text: "كالسابق، ويعتمد الكشف ويصرفه لموظفي فرعه. مناسب لمن تثق به تماماً." },
        ]}
      />
    </div>,

    // 5 -- review
    <div key="review" className="space-y-4" data-testid="rules-review">
      <Hint summary="هكذا ستُحسب الرواتب. جرّب راتباً لترى المبالغ الفعلية لكل قاعدة." />
      <Field label="راتب شهري للتجربة">
        <input value={sample} onChange={(e) => setSample(e.target.value)} className={`${inputCls} max-w-[220px]`} dir="ltr" inputMode="numeric" data-testid="sample-salary" />
      </Field>
      <div className="rounded-md border border-ink-200 divide-y divide-ink-100 text-sm font-arabic" data-testid="examples">
        {exampleLines(live, sampleSalary).map((l) => (
          <div key={l.label} className="flex justify-between p-2.5">
            <span>{l.label}</span>
            <span className={`font-mono ${l.amount < 0 ? "text-danger" : "text-ok"}`}>{l.amount === 0 ? "لا شيء" : formatMoney(l.amount)}</span>
          </div>
        ))}
      </div>
      <p className="text-xs font-arabic text-ink-500">يمكنك تغيير هذه القواعد في أي وقت. التغيير يسري على الرواتب التي لم تُعتمد بعد، أما الرواتب المعتمدة فتبقى كما اعتُمدت.</p>
    </div>,
  ];

  if (!wizard) {
    return (
      <div className="space-y-8" data-testid="rules-editor">
        {sections.map((sec, i) => (
          <section key={i} className="zc-card p-5 space-y-3">
            <h2 className="font-bold font-arabic text-ink-900">{STEP_TITLES[i]}</h2>
            {sec}
          </section>
        ))}
        <div className="flex justify-end">
          <button onClick={save} disabled={saving} className={btnPrimary} data-testid="rules-save">{saving ? "جاري الحفظ..." : "حفظ القواعد"}</button>
        </div>
      </div>
    );
  }

  const last = step === sections.length - 1;
  return (
    <div className="zc-card p-5 space-y-4" data-testid="rules-wizard">
      <div className="space-y-1">
        <p className="text-xs font-arabic text-ink-400">الخطوة {step + 1} من {sections.length}</p>
        <h2 className="text-lg font-bold font-arabic text-ink-900">{STEP_TITLES[step]}</h2>
        <div className="h-1.5 bg-ink-100 rounded-full overflow-hidden"><div className="h-full bg-saffron-600" style={{ width: `${((step + 1) / sections.length) * 100}%` }} /></div>
      </div>
      {sections[step]}
      <div className="flex justify-between pt-2">
        <button onClick={() => setStep((n) => Math.max(0, n - 1))} disabled={step === 0} className={btnGhost}>السابق</button>
        {last ? (
          <button onClick={save} disabled={saving} className={btnPrimary} data-testid="rules-save">{saving ? "جاري الحفظ..." : "حفظ وبدء استخدام الرواتب"}</button>
        ) : (
          <button onClick={() => setStep((n) => n + 1)} className={btnPrimary} data-testid="rules-next">التالي</button>
        )}
      </div>
    </div>
  );
}
