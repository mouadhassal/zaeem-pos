import { useCallback, useEffect, useRef, useState } from "react";
import { IconPencil, IconTrash, IconX } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { useOptionsStore } from "../../stores/optionsStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney, minorToInputValue, parseMoneyInput } from "../../lib/money";
import { realErrorText } from "../../lib/errors";
import type { OptionGroup } from "../../lib/itemOptions";
import { quickChoice } from "../../lib/itemOptions";

interface CategoryLite { id: string; name: string }
interface ItemLite { id: string; name: string; category_id: string }

interface Draft {
  id: string | null;
  name: string;
  selection: "MULTI" | "SINGLE";
  required: boolean;
  is_active: boolean;
  choices: { name: string; price: string }[];
  categoryIds: string[];
  itemIds: string[];
}

const EMPTY: Draft = { id: null, name: "", selection: "MULTI", required: false, is_active: true, choices: [], categoryIds: [], itemIds: [] };

function toDraft(g: OptionGroup): Draft {
  return {
    id: g.id,
    name: g.name,
    selection: g.selection,
    required: g.required,
    is_active: g.is_active,
    choices: g.choices.map((c) => ({ name: c.name, price: c.price_cents ? minorToInputValue(c.price_cents) : "" })),
    categoryIds: g.targets.filter((t) => t.target_type === "CATEGORY").map((t) => t.target_id),
    itemIds: g.targets.filter((t) => t.target_type === "ITEM").map((t) => t.target_id),
  };
}

/**
 * Menu > Options ("الإضافات والملاحظات"): the lists a cashier picks from when
 * an item is tapped -- "without onion", "extra cheese +2,000", "size". A group
 * applies to whole categories and/or single items. The price of an option is
 * decided here and enforced by the server; the till cannot change it.
 */
export default function OptionsTab({ categories, items }: { categories: CategoryLite[]; items: ItemLite[] }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [groups, setGroups] = useState<OptionGroup[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [quick, setQuick] = useState("");
  const [itemPick, setItemPick] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const editorRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      setGroups(await invoke<OptionGroup[]>("list_option_groups_v3", { sessionToken: token, includeInactive: true }));
      // The till keeps its own copy of the active groups; without this a group
      // created here did nothing at the till until the app was restarted.
      void useOptionsStore.getState().load(token, true);
    } catch (e) {
      toast.error(`تعذر تحميل الإضافات: ${realErrorText(e)}`);
    }
  }, [token, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // The editor used to open below the list, out of sight: bring it into view.
  useEffect(() => {
    if (draft) editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [draft === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const targetsSummary = (g: OptionGroup) => {
    const cats = g.targets.filter((t) => t.target_type === "CATEGORY").map((t) => categories.find((c) => c.id === t.target_id)?.name).filter(Boolean);
    const its = g.targets.filter((t) => t.target_type === "ITEM").map((t) => items.find((i) => i.id === t.target_id)?.name).filter(Boolean);
    const all = [...cats.map((n) => `تصنيف: ${n}`), ...its];
    return all.length ? all.join("، ") : "غير مرتبطة بأي صنف";
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return toast.error("اكتب اسم المجموعة");
    if (draft.choices.length === 0) return toast.error("أضف خياراً واحداً على الأقل");
    if (draft.choices.some((c) => !c.name.trim())) return toast.error("يوجد خيار بلا اسم");
    setSaving(true);
    try {
      await invoke("save_option_group_v3", {
        sessionToken: token,
        group: {
          id: draft.id,
          name: draft.name.trim(),
          selection: draft.selection,
          required: draft.required,
          sort_order: groups.find((g) => g.id === draft.id)?.sort_order ?? groups.length,
          is_active: draft.is_active,
          choices: draft.choices.map((c) => ({ name: c.name.trim(), price_cents: c.price.trim() ? parseMoneyInput(c.price) : 0 })),
          targets: [
            ...draft.categoryIds.map((id) => ({ target_type: "CATEGORY", target_id: id })),
            ...draft.itemIds.map((id) => ({ target_type: "ITEM", target_id: id })),
          ],
        },
      });
      toast.success("تم حفظ المجموعة ✓");
      setDraft(null);
      await load();
    } catch (e) {
      toast.error(`تعذر الحفظ: ${realErrorText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await invoke("delete_option_group_v3", { sessionToken: token, groupId: id });
      toast.success("تم حذف المجموعة ✓");
      setConfirmDelete(null);
      await load();
    } catch (e) {
      toast.error(`تعذر الحذف: ${realErrorText(e)}`);
    }
  };

  const addQuick = (kind: "without" | "extra" | "plain") => {
    if (!draft || !quick.trim()) return;
    const c = quickChoice(kind, quick);
    if (draft.choices.some((x) => x.name === c.name)) return toast.error("هذا الخيار موجود");
    setDraft({ ...draft, choices: [...draft.choices, { name: c.name, price: "" }] });
    setQuick("");
  };

  const input = "h-10 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-600";

  return (
    <div className="space-y-4" data-testid="options-tab">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-500 font-arabic">
          قوائم يختار منها الكاشير عند الضغط على صنف: «بدون بصل»، «زيادة جبنة +٢٠٠٠»، الحجم... وتظهر في المطبخ والفاتورة.
        </p>
        <button
          onClick={() => setDraft({ ...EMPTY })}
          className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors shrink-0"
          data-testid="options-add-group"
        >
          + مجموعة جديدة
        </button>
      </div>

      {draft && (
        <div ref={editorRef} className="rounded-md border-2 border-saffron-600 bg-white p-5 space-y-4 scroll-mt-4" data-testid="option-group-editor">
          <div className="flex items-center justify-between">
            <h3 className="font-arabic font-bold text-ink-900">{draft.id ? "تعديل المجموعة" : "مجموعة جديدة"}</h3>
            <button onClick={() => setDraft(null)} className="p-1 text-ink-500 hover:text-ink-900"><IconX className="w-5 h-5" /></button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-ink-500 font-arabic">اسم المجموعة</span>
              <input className={`${input} w-full`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="مثال: إضافات الساندويش" data-testid="option-group-name" />
            </label>
            <div className="space-y-1">
              <span className="text-xs text-ink-500 font-arabic">طريقة الاختيار</span>
              <div className="flex gap-2">
                {(["MULTI", "SINGLE"] as const).map((s) => (
                  <button key={s} onClick={() => setDraft({ ...draft, selection: s })} className={`h-10 px-4 rounded-sm text-sm font-arabic ${draft.selection === s ? "bg-saffron-600 text-white" : "bg-ink-100 text-ink-700"}`}>
                    {s === "MULTI" ? "عدة خيارات" : "اختيار واحد"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-5 text-sm font-arabic text-ink-700">
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} /> إجباري (يجب اختيار شيء)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} /> مفعّلة</label>
          </div>

          <div className="space-y-2">
            <span className="text-xs text-ink-500 font-arabic">الخيارات</span>
            <div className="flex gap-2 flex-wrap">
              <input className={`${input} flex-1 min-w-[10rem]`} value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="اكتب مكوّناً: بصل، كاتشب، جبنة..." data-testid="option-quick-input" />
              <button onClick={() => addQuick("without")} className="h-10 px-3 rounded-sm bg-ink-100 text-ink-800 text-sm font-arabic hover:bg-ink-200" data-testid="option-quick-without">+ بدون</button>
              <button onClick={() => addQuick("extra")} className="h-10 px-3 rounded-sm bg-ink-100 text-ink-800 text-sm font-arabic hover:bg-ink-200" data-testid="option-quick-extra">+ زيادة</button>
              <button onClick={() => addQuick("plain")} className="h-10 px-3 rounded-sm bg-ink-100 text-ink-800 text-sm font-arabic hover:bg-ink-200">+ كما هو</button>
            </div>
            {draft.choices.map((c, i) => (
              <div key={i} className="flex gap-2 items-center" data-testid="option-choice-row">
                <input className={`${input} flex-1`} value={c.name} onChange={(e) => setDraft({ ...draft, choices: draft.choices.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <input className={`${input} w-28`} inputMode="decimal" value={c.price} placeholder="مجاني" onChange={(e) => setDraft({ ...draft, choices: draft.choices.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} />
                <button onClick={() => setDraft({ ...draft, choices: draft.choices.filter((_, j) => j !== i) })} className="p-2 text-ink-500 hover:text-danger"><IconX className="w-4 h-4" /></button>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <span className="text-xs text-ink-500 font-arabic">تظهر عند الضغط على</span>
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => {
                const on = draft.categoryIds.includes(c.id);
                return (
                  <button key={c.id} onClick={() => setDraft({ ...draft, categoryIds: on ? draft.categoryIds.filter((x) => x !== c.id) : [...draft.categoryIds, c.id] })}
                    className={`px-3 py-1 rounded-full text-xs font-arabic ${on ? "bg-saffron-600 text-white" : "bg-white border border-ink-200 text-ink-500 hover:bg-ink-200"}`} data-testid="option-target-category">
                    {c.name}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2 items-center">
              <select className={`${input} flex-1`} value={itemPick} onChange={(e) => {
                const id = e.target.value;
                if (id && !draft.itemIds.includes(id)) setDraft({ ...draft, itemIds: [...draft.itemIds, id] });
                setItemPick("");
              }}>
                <option value="">+ أو اختر صنفاً محدداً...</option>
                {items.filter((i) => !draft.itemIds.includes(i.id)).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              {draft.itemIds.map((id) => (
                <span key={id} className="px-3 py-1 rounded-full text-xs font-arabic bg-saffron-600 text-white inline-flex items-center gap-1">
                  {items.find((i) => i.id === id)?.name ?? "—"}
                  <button onClick={() => setDraft({ ...draft, itemIds: draft.itemIds.filter((x) => x !== id) })}><IconX className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
          </div>

          <div className="flex gap-2 justify-end">
            <button onClick={() => setDraft(null)} className="h-10 px-5 rounded-sm bg-ink-100 text-ink-700 text-sm font-bold">إلغاء</button>
            <button onClick={save} disabled={saving} className="h-10 px-6 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 disabled:opacity-50" data-testid="option-group-save">
              {saving ? "..." : "حفظ"}
            </button>
          </div>
        </div>
      )}
      {groups.length === 0 && !draft && (
        <div className="text-center text-ink-500 font-arabic py-10">لا توجد إضافات بعد. أنشئ مجموعة مثل «إضافات الساندويش» واربطها بتصنيف.</div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {groups.map((g) => (
          <div key={g.id} className={`rounded-md border border-ink-200 bg-white p-4 space-y-2 ${g.is_active ? "" : "opacity-60"}`} data-testid="option-group-card">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-arabic font-bold text-ink-900">{g.name}</div>
                <div className="text-xs text-ink-500 font-arabic">
                  {g.selection === "SINGLE" ? "اختيار واحد" : "عدة خيارات"}
                  {g.required ? " · إجباري" : ""}
                  {g.is_active ? "" : " · متوقف"}
                </div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => setDraft(toDraft(g))} className="p-2 rounded-sm text-ink-500 hover:text-saffron-600 hover:bg-saffron-50" title="تعديل">
                  <IconPencil className="w-4 h-4" />
                </button>
                <button onClick={() => setConfirmDelete(g.id)} className="p-2 rounded-sm text-ink-500 hover:text-danger hover:bg-danger-soft" title="حذف">
                  <IconTrash className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.choices.map((c) => (
                <span key={c.id} className="px-2.5 py-1 rounded-full bg-ink-100 text-ink-700 text-xs font-arabic">
                  {c.name}
                  {c.price_cents > 0 ? ` +${formatMoney(c.price_cents)}` : ""}
                </span>
              ))}
            </div>
            {g.targets.length === 0 ? (
              <div className="text-xs font-arabic font-bold text-danger bg-danger-soft rounded-sm px-2 py-1.5" data-testid="option-group-unlinked">
                ⚠ غير مرتبطة بأي صنف أو تصنيف — لن تظهر عند البيع. اضغط تعديل واختر التصنيف.
              </div>
            ) : (
              <div className="text-xs text-ink-500 font-arabic">{targetsSummary(g)}</div>
            )}
            {confirmDelete === g.id && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-danger font-arabic">حذف المجموعة؟ الطلبات القديمة لا تتأثر.</span>
                <button onClick={() => remove(g.id)} className="h-8 px-3 rounded-sm bg-danger text-white text-xs font-bold">حذف</button>
                <button onClick={() => setConfirmDelete(null)} className="h-8 px-3 rounded-sm bg-ink-100 text-ink-700 text-xs font-bold">إلغاء</button>
              </div>
            )}
          </div>
        ))}
      </div>

    </div>
  );
}
