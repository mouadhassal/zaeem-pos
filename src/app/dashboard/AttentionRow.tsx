import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react";

interface Props {
  id: string;
  title: string;
  /** What is wrong, in a few words: "3 مواد", "1,200". null = nothing to worry about. */
  problem: string | null;
  /** One line: what it means. */
  hint: string;
  onOpen: () => void;
}

/** One of the things that need attention: a green tick when all is well, an orange warning when not. */
export default function AttentionRow({ id, title, problem, hint, onOpen }: Props) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`dash-card-${id}`}
      className="zc-card w-full p-4 flex items-center gap-3 text-right hover:border-saffron-600 transition-colors"
    >
      {problem ? <IconAlertTriangle className="w-7 h-7 text-warn shrink-0" /> : <IconCircleCheck className="w-7 h-7 text-ok shrink-0" />}
      <div className="flex-1 min-w-0">
        <p className="font-bold text-ink-900 font-arabic">{title}</p>
        <p className="text-sm text-ink-500 font-arabic">{hint}</p>
      </div>
      <p className={`text-xl font-bold font-mono shrink-0 ${problem ? "text-warn" : "text-ok"}`}>{problem ?? "تمام"}</p>
    </button>
  );
}
