import { IconBriefcase } from "@tabler/icons-react";

/**
 * شواغر: where a restaurant will find new staff through a hiring partner. Placeholder until the
 * partnership is signed; it shows no listings and collects nothing.
 */
export default function JobsPage() {
  return (
    <div className="h-full flex items-center justify-center px-6" dir="rtl" data-testid="jobs-page">
      <div className="max-w-md text-center flex flex-col items-center gap-3">
        <div className="w-16 h-16 rounded-full bg-accent-soft flex items-center justify-center">
          <IconBriefcase className="w-8 h-8 text-accent-text" stroke={1.5} />
        </div>
        <h1 className="m-0 text-xl font-bold text-text font-arabic">شواغر</h1>
        <span className="px-3 py-1 rounded-full bg-surface-alt text-sm font-medium text-text-2 font-arabic" data-testid="jobs-soon">قريباً</span>
        <p className="m-0 text-sm text-text-muted font-arabic leading-relaxed">
          تحتاج موظفاً جديداً لمطعمك؟ نجهّز هذه الخدمة بالشراكة مع شركة توظيف متخصصة، لتجد الطباخ أو الكاشير أو السائق المناسب من هنا مباشرة.
        </p>
      </div>
    </div>
  );
}
