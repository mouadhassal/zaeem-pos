import type { ReactNode } from "react";

/** What a tab shows while loading, and when none of its numbers could be read. */
export default function TabState({ loading, empty, children }: { loading: boolean; empty: boolean; children: ReactNode }) {
  if (loading) return <div className="py-10 text-center text-ink-500 font-arabic">جاري التحميل...</div>;
  if (empty) {
    return (
      <div className="py-10 text-center text-ink-500 font-arabic" data-testid="dash-empty">
        لا توجد أرقام لعرضها هنا. قد لا تملك صلاحية رؤيتها، أو لا توجد بيانات في هذه الفترة.
      </div>
    );
  }
  return <>{children}</>;
}

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">{children}</div>;
}
