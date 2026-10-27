import { useEffect, useMemo, useState } from "react";
import { IconSearch, IconChevronDown, IconAlertTriangle, IconBulb } from "@tabler/icons-react";
import { useAuthStore } from "../../stores/authStore";
import { usePlanStore } from "../../stores/planStore";
import { chaptersFor, guideRoleOf, searchChapters, type GuideChapter, type GuideTask } from "../../lib/guide";

const ROLE_NAMES = { CASHIER: "الكاشير", KITCHEN: "المطبخ", MANAGER: "المدير", OWNER: "المالك", ACCOUNTANT: "المحاسب" } as const;

function List({ items, ordered }: { items: string[]; ordered?: boolean }) {
  if (ordered) {
    return (
      <ol className="space-y-2.5">
        {items.map((text, i) => (
          <li key={i} className="flex gap-3 items-start">
            <span className="shrink-0 w-6 h-6 rounded-full bg-saffron-50 text-saffron-600 text-xs font-bold flex items-center justify-center tabular mt-0.5">
              {i + 1}
            </span>
            <span className="text-sm text-ink-900 font-arabic leading-relaxed">{text}</span>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((text, i) => (
        <li key={i} className="flex gap-2.5 items-start">
          <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-ink-300 mt-2" />
          <span className="text-sm text-ink-900 font-arabic leading-relaxed">{text}</span>
        </li>
      ))}
    </ul>
  );
}

function Callout({ kind, items }: { kind: "tip" | "warn"; items: string[] }) {
  const warn = kind === "warn";
  const Icon = warn ? IconAlertTriangle : IconBulb;
  return (
    <div className={`rounded-md p-3 space-y-1.5 ${warn ? "bg-danger-100" : "bg-saffron-50"}`}>
      <div className={`flex items-center gap-1.5 text-xs font-bold font-arabic ${warn ? "text-danger-600" : "text-saffron-600"}`}>
        <Icon className="w-4 h-4" stroke={1.75} />
        {warn ? "انتبه" : "نصيحة"}
      </div>
      {items.map((text, i) => (
        <p key={i} className="text-sm text-ink-900 font-arabic leading-relaxed">{text}</p>
      ))}
    </div>
  );
}

function TaskCard({ task, open, onToggle }: { task: GuideTask; open: boolean; onToggle: () => void }) {
  return (
    <section className="bg-white rounded-md border border-ink-200" data-testid="guide-task">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 text-start"
      >
        <span className="font-arabic font-bold text-ink-900 text-[15px]">{task.title}</span>
        <IconChevronDown className={`w-4 h-4 text-ink-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} stroke={1.75} />
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-4 border-t border-ink-100 pt-4">
          {task.when && <p className="text-sm text-ink-500 font-arabic">{task.when}</p>}
          {task.steps && task.steps.length > 0 && <List items={task.steps} ordered />}
          {task.points && task.points.length > 0 && <List items={task.points} />}
          {task.tips && task.tips.length > 0 && <Callout kind="tip" items={task.tips} />}
          {task.warnings && task.warnings.length > 0 && <Callout kind="warn" items={task.warnings} />}
        </div>
      )}
    </section>
  );
}

export default function GuidePage() {
  const user = useAuthStore((s) => s.user);
  const posLite = usePlanStore((s) => s.posLite);
  const myRole = guideRoleOf(user?.role);

  const [allGuides, setAllGuides] = useState(false);
  const [query, setQuery] = useState("");
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [openTasks, setOpenTasks] = useState<Set<string>>(new Set());

  const visible = useMemo(() => chaptersFor(allGuides ? null : myRole, posLite), [allGuides, myRole, posLite]);
  const searching = query.trim().length > 0;
  const results = useMemo(() => searchChapters(visible, query), [visible, query]);

  // A chapter that disappears (role switch, search) hands the selection to the first one left.
  const chapter: GuideChapter | undefined = results.find((c) => c.id === chapterId) ?? results[0];
  useEffect(() => {
    if (chapter && chapter.id !== chapterId) setChapterId(chapter.id);
  }, [chapter, chapterId]);

  // Searching opens every match so the answer is on screen; browsing opens the first task.
  useEffect(() => {
    if (!chapter) return;
    setOpenTasks(new Set(searching ? chapter.tasks.map((t) => t.id) : chapter.tasks.slice(0, 1).map((t) => t.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.id, searching]);

  const toggle = (id: string) =>
    setOpenTasks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOpen = !!chapter && chapter.tasks.every((t) => openTasks.has(t.id));

  return (
    <div className="flex h-full overflow-hidden bg-canvas" dir="rtl" data-testid="guide-page">
      <nav className="w-72 bg-surface-alt border-l border-ink-200 flex flex-col shrink-0">
        <div className="p-3 space-y-2.5 border-b border-ink-200">
          <h1 className="text-lg font-bold text-ink-900 font-arabic px-1">دليل الاستخدام</h1>
          <div className="relative">
            <IconSearch className="w-4 h-4 text-ink-400 absolute top-1/2 -translate-y-1/2 start-3" stroke={1.75} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ابحث: طابعة، استرداد، وردية…"
              className="w-full h-10 ps-9 pe-3 rounded-sm border-2 border-ink-200 bg-white text-sm font-arabic outline-none focus:border-saffron-500"
              data-testid="guide-search"
            />
          </div>
          <div className="grid grid-cols-2 gap-1 bg-white rounded-sm p-1 border border-ink-200" role="radiogroup" aria-label="عرض الأدلة">
            {([false, true] as const).map((all) => (
              <button
                key={String(all)}
                type="button"
                role="radio"
                aria-checked={allGuides === all}
                onClick={() => setAllGuides(all)}
                className={`h-8 rounded-[6px] text-xs font-arabic transition-colors ${
                  allGuides === all ? "bg-saffron-600 text-white font-bold" : "text-ink-500 hover:text-ink-900"
                }`}
              >
                {all ? "كل الأدلة" : `دليل ${ROLE_NAMES[myRole]}`}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-500 font-arabic text-center">لا نتائج لهذا البحث. جرّب كلمة أبسط.</p>
          ) : (
            results.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setChapterId(c.id)}
                data-testid={`guide-chapter-${c.id}`}
                className={`w-full text-start px-4 py-2.5 font-arabic text-sm transition-colors flex items-center justify-between gap-2 ${
                  chapter?.id === c.id
                    ? "bg-saffron-50 text-saffron-600 font-bold border-e-2 border-saffron-600"
                    : "text-ink-700 hover:bg-white"
                }`}
              >
                <span>{c.title}</span>
                {searching && <span className="text-[11px] text-ink-400 tabular shrink-0">{c.tasks.length}</span>}
              </button>
            ))
          )}
        </div>
      </nav>

      <main className="flex-1 overflow-y-auto p-6">
        {chapter ? (
          <div className="max-w-3xl space-y-4">
            <header className="space-y-1">
              <h2 className="text-xl font-bold text-ink-900 font-arabic">{chapter.title}</h2>
              <p className="text-sm text-ink-500 font-arabic leading-relaxed">{chapter.blurb}</p>
            </header>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setOpenTasks(allOpen ? new Set() : new Set(chapter.tasks.map((t) => t.id)))}
                className="text-xs font-arabic text-saffron-600 hover:underline"
              >
                {allOpen ? "طي الكل" : "فتح الكل"}
              </button>
            </div>
            {chapter.tasks.map((task) => (
              <TaskCard key={task.id} task={task} open={openTasks.has(task.id)} onToggle={() => toggle(task.id)} />
            ))}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-ink-500 font-arabic">اختر موضوعاً من القائمة</div>
        )}
      </main>
    </div>
  );
}
