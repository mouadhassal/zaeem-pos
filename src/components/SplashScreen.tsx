import { useEffect, useState } from "react";

interface Props {
  onComplete: () => void;
}

const STEPS = [
  { label: "جاري تهيئة قاعدة البيانات...", duration: 600 },
  { label: "جاري التحقق من سلامة البيانات...", duration: 400 },
  { label: "جاري تحميل القائمة...", duration: 500 },
  { label: "جاري التحميل...", duration: 300 },
];

export default function SplashScreen({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (step >= STEPS.length) {
      onComplete();
      return;
    }

    const current = STEPS[step];
    const startTime = performance.now();
    const startProgress = (step / STEPS.length) * 100;
    const endProgress = ((step + 1) / STEPS.length) * 100;

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / current.duration, 1);
      setProgress(startProgress + (endProgress - startProgress) * t);

      if (t >= 1) {
        setStep((s) => s + 1);
      } else {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }, [step, onComplete]);

  return (
    <div
      className="h-screen w-screen bg-slate-50 flex flex-col items-center justify-center"
      dir="rtl"
    >
      <div className="flex flex-col items-center gap-8">
        <div className="w-16 h-16 rounded-2xl bg-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-600\/30">
          <span className="text-white text-3xl font-bold">ز</span>
        </div>

        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-slate-900">زعيم</h1>
          <p className="text-sm text-slate-500 font-arabic">نقاط البيع</p>
        </div>

        <div className="w-64 space-y-3">
          <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-600 rounded-full transition-all duration-100 ease-linear"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 text-center font-arabic">
            {STEPS[Math.min(step, STEPS.length - 1)]?.label ?? ""}
          </p>
        </div>
      </div>
    </div>
  );
}
