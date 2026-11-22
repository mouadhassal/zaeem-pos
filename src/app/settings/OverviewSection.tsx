import { useState, type ReactNode } from "react";
import { IconChevronDown, IconChevronLeft } from "@tabler/icons-react";

interface Props {
  id: string;
  title: string;
  /** What is inside, in a few words: "12 طاولة". */
  count: string;
  /** The screen where this is edited. */
  editLabel?: string | undefined;
  onEdit?: (() => void) | undefined;
  /** When the section could not be read (no permission, a part switched off). */
  unavailable?: string | undefined;
  children?: ReactNode;
}

/** One collapsible block of the setup overview: a title, how many, a link to where it is edited. */
export default function OverviewSection({ id, title, count, editLabel, onEdit, unavailable, children }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <section className="bg-white rounded-md border border-ink-200" data-testid={`overview-${id}`}>
      <div className="flex items-center gap-3 p-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex-1 flex items-center gap-2 text-right"
          data-testid={`overview-${id}-toggle`}
        >
          {open ? <IconChevronDown className="w-4 h-4 text-ink-400" /> : <IconChevronLeft className="w-4 h-4 text-ink-400" />}
          <span className="font-bold text-ink-900 font-arabic">{title}</span>
          <span className="text-sm text-ink-500 font-arabic bg-ink-100 rounded-md px-2 py-0.5">{unavailable ? "غير متاح" : count}</span>
        </button>
        {onEdit && editLabel && (
          <button type="button" onClick={onEdit} className="text-sm text-saffron-600 hover:text-saffron-700 font-bold font-arabic" data-testid={`overview-${id}-edit`}>
            {editLabel}
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-ink-100 p-4 text-sm font-arabic text-ink-900">
          {unavailable ? <p className="text-ink-500">{unavailable}</p> : children}
        </div>
      )}
    </section>
  );
}
