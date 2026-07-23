import { useState, useRef, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { Camera, Upload, Mic, Check, X, ChevronUp, RotateCcw, Plus, Trash2 } from "lucide-react";
import { useAuthStore } from "../../stores/authStore";

interface DraftCategory {
  name: string;
  sort_order: number;
  confidence: number;
}

interface DraftModifier {
  ar_name: string;
  price_cents: number;
}

interface DraftItem {
  ar_name: string;
  en_name: string | null;
  price_cents: number;
  category_name: string;
  modifiers: DraftModifier[];
  confidence: number;
}

interface DraftMenu {
  categories: DraftCategory[];
  items: DraftItem[];
}

interface UploadItem {
  id: string;
  kind: string;
  filename: string;
  status: string;
  error: string | null;
  draft_menu: DraftMenu | null;
}

function confidenceColor(c: number): string {
  if (c >= 0.9) return "text-live-600 bg-live-100";
  if (c >= 0.7) return "text-wait-600 bg-wait-100";
  return "text-stop-600 bg-stop-100";
}

function confidenceLabel(c: number): string {
  if (c >= 0.9) return "عالي";
  if (c >= 0.7) return "متوسط";
  return "منخفض";
}

function formatCents(c: number): string {
  return (c / 100).toFixed(2);
}

function parseCents(s: string): number {
  return Math.round(parseFloat(s || "0") * 100);
}

export default function AiOnboardingPage() {
  const token = useAuthStore((s) => s.token);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedDraft, setEditedDraft] = useState<DraftMenu | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const refreshUploads = useCallback(async () => {
    try {
      const items = await invoke<UploadItem[]>("list_uploads", { sessionToken: token });
      setUploads(items);
      if (selectedIdx !== null && items.length <= selectedIdx) {
        setSelectedIdx(null);
      }
    } catch (e) {
      console.error("Failed to list uploads:", e);
    }
  }, [selectedIdx, token]);

  const handleFiles = async (files: FileList | null, kind: string) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const buf = await file.arrayBuffer();
      const data = Array.from(new Uint8Array(buf));
      try {
        await invoke("queue_media", {
          request: {
            session_token: token,
            kind,
            filename: file.name,
            data,
            mime: file.type || (kind === "PHOTO" ? "image/jpeg" : "audio/webm"),
          },
        });
      } catch (e) {
        console.error("Failed to queue media:", e);
      }
    }
    await refreshUploads();
  };

  const processAll = async () => {
    setProcessing(true);
    try {
      await invoke("process_queue", { sessionToken: token });
      await refreshUploads();
    } catch (e) {
      console.error("Failed to process queue:", e);
    } finally {
      setProcessing(false);
    }
  };

  const selectUpload = (idx: number) => {
    setSelectedIdx(idx);
    setEditing(false);
    setEditedDraft(null);
    setApplyResult(null);
  };

  const startEditing = () => {
    const item = selectedIdx !== null ? uploads[selectedIdx] : null;
    if (!item?.draft_menu) return;
    setEditedDraft(JSON.parse(JSON.stringify(item.draft_menu)));
    setEditing(true);
    setApplyResult(null);
  };

  const removeItem = (itemIdx: number) => {
    if (!editedDraft) return;
    const items = editedDraft.items.filter((_, i) => i !== itemIdx);
    const updated = { ...editedDraft, items };
    setEditedDraft(updated);
  };

  const updateItem = (idx: number, field: string, value: string | number) => {
    if (!editedDraft) return;
    const items = [...editedDraft.items];
    items[idx] = { ...items[idx], [field]: value };
    setEditedDraft({ ...editedDraft, items });
  };

  const moveItem = (idx: number, dir: -1 | 1) => {
    if (!editedDraft) return;
    const items = [...editedDraft.items];
    const target = idx + dir;
    if (target < 0 || target >= items.length) return;
    [items[idx], items[target]] = [items[target], items[idx]];
    setEditedDraft({ ...editedDraft, items });
  };

  const addModifier = (itemIdx: number) => {
    if (!editedDraft) return;
    const items = [...editedDraft.items];
    items[itemIdx] = {
      ...items[itemIdx],
      modifiers: [...items[itemIdx].modifiers, { ar_name: "", price_cents: 0 }],
    };
    setEditedDraft({ ...editedDraft, items });
  };

  const updateModifier = (itemIdx: number, modIdx: number, field: string, value: string | number) => {
    if (!editedDraft) return;
    const items = [...editedDraft.items];
    const mods = [...items[itemIdx].modifiers];
    mods[modIdx] = { ...mods[modIdx], [field]: value };
    items[itemIdx] = { ...items[itemIdx], modifiers: mods };
    setEditedDraft({ ...editedDraft, items });
  };

  const removeModifier = (itemIdx: number, modIdx: number) => {
    if (!editedDraft) return;
    const items = [...editedDraft.items];
    items[itemIdx] = {
      ...items[itemIdx],
      modifiers: items[itemIdx].modifiers.filter((_, i) => i !== modIdx),
    };
    setEditedDraft({ ...editedDraft, items });
  };

  const applyDraft = async () => {
    if (!editedDraft) return;
    setApplying(true);
    setApplyResult(null);
    try {
      const result = await invoke<{ categories_created: number; items_created: number }>("apply_draft", {
        request: { session_token: token, draft: editedDraft },
      });
      setApplyResult(`✅ تم إنشاء ${result.categories_created} تصنيف و ${result.items_created} صنف بنجاح`);
      setEditing(false);
    } catch (e) {
      setApplyResult(`❌ فشل التطبيق: ${e}`);
    } finally {
      setApplying(false);
    }
  };

  const selectedItem = selectedIdx !== null ? uploads[selectedIdx] : null;
  const displayDraft = editing ? editedDraft : selectedItem?.draft_menu ?? null;

  return (
    <div className="h-full flex flex-col overflow-hidden" dir="rtl">
      <header className="bg-saffron-600 text-white px-6 py-3 flex items-center gap-3 flex-shrink-0">
        <Camera className="w-5 h-5" />
        <h1 className="font-bold text-lg">الإعداد الذكي للقائمة</h1>
        <span className="text-saffron-200 text-xs">AI Onboarding</span>
      </header>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Upload bar */}
        <div className="bg-white border-b border-ink-200 px-6 py-3 flex items-center gap-3 flex-shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files, "PHOTO")}
          />
          <input
            ref={audioInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files, "AUDIO")}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="h-9 px-4 rounded-xl bg-saffron-600 text-white text-sm flex items-center gap-2 hover:bg-saffron-700 transition-colors"
          >
            <Camera className="w-4 h-4" />
            إضافة صور
          </button>
          <button
            onClick={() => audioInputRef.current?.click()}
            className="h-9 px-4 rounded-xl border border-ink-300 text-ink-700 text-sm flex items-center gap-2 hover:bg-ink-100 transition-colors"
          >
            <Mic className="w-4 h-4" />
            تسجيل صوتي
          </button>
          <div className="mr-auto flex items-center gap-3">
            {uploads.length > 0 && !editing && (
              <button
                onClick={processAll}
                disabled={processing}
                className="h-9 px-4 rounded-xl bg-live-600 text-white text-sm flex items-center gap-2 hover:bg-live-700 transition-colors disabled:opacity-50"
              >
                {processing ? "جاري المعالجة..." : "معالجة الكل"}
              </button>
            )}
            {uploads.some((u) => u.status === "FAILED") && (
              <button
                onClick={async () => { await invoke("reset_failed_uploads", { sessionToken: token }); await refreshUploads(); }}
                className="h-9 px-4 rounded-xl border border-ink-300 text-ink-700 text-sm flex items-center gap-2 hover:bg-ink-100 transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
                إعادة المحاولة
              </button>
            )}
            <span className="text-ink-400 text-xs">{uploads.length} ملف</span>
          </div>
        </div>

        {/* Photo strip */}
        {uploads.length > 0 && (
          <div className="bg-white border-b border-ink-200 px-4 py-2 flex gap-2 overflow-x-auto flex-shrink-0">
            {uploads.map((u, i) => (
              <button
                key={u.id}
                onClick={() => selectUpload(i)}
                className={`flex-shrink-0 w-16 h-16 rounded-xl border-2 transition-colors overflow-hidden relative ${
                  selectedIdx === i
                    ? "border-saffron-500 shadow-sh-1"
                    : "border-ink-200 hover:border-ink-400"
                }`}
              >
                <div
                  className={`w-full h-full flex items-center justify-center text-xs font-bold ${
                    u.status === "DONE"
                      ? "bg-live-100 text-live-700"
                      : u.status === "FAILED"
                      ? "bg-stop-100 text-stop-700"
                      : u.status === "PROCESSING"
                      ? "bg-wait-100 text-wait-700"
                      : "bg-ink-100 text-ink-500"
                  }`}
                >
                  {u.kind === "AUDIO" ? "🎤" : "📷"}
                </div>
                <div className="absolute bottom-0 left-0 right-0 text-[8px] text-center bg-black/50 text-white leading-tight truncate px-1">
                  {u.status === "DONE" ? "تم" : u.status === "FAILED" ? "فشل" : u.status === "PROCESSING" ? "..." : "..."}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Main content area */}
        <div className="flex-1 flex overflow-hidden">
          {selectedItem && displayDraft ? (
            <>
              {/* Photo preview */}
              <div className="w-1/3 border-l border-ink-200 bg-ink-50 p-4 flex items-center justify-center overflow-hidden">
                <div className="text-center text-ink-400">
                  <Camera className="w-16 h-16 mx-auto mb-2 opacity-30" />
                  <p className="text-sm font-arabic">معاينة الصورة</p>
                  {selectedItem.error && (
                    <p className="text-xs text-stop-600 mt-2 font-arabic">{selectedItem.error}</p>
                  )}
                </div>
              </div>

              {/* Extraction results */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {editing && applyResult && (
                  <div className="px-4 py-3 rounded-xl bg-live-100 text-live-800 text-sm font-arabic">{applyResult}</div>
                )}

                <div className="flex items-center justify-between">
                  <h2 className="font-bold text-ink-900 text-lg font-arabic">
                    {editing ? "تعديل البيانات المستخرجة" : "البيانات المستخرجة"}
                  </h2>
                  <div className="flex gap-2">
                    {!editing && selectedItem.status === "DONE" && (
                      <button
                        onClick={startEditing}
                        className="h-9 px-4 rounded-xl bg-saffron-600 text-white text-sm hover:bg-saffron-700 transition-colors"
                      >
                        تعديل
                      </button>
                    )}
                    {editing && (
                      <>
                        <button
                          onClick={() => { setEditing(false); setEditedDraft(null); setApplyResult(null); }}
                          className="h-9 px-4 rounded-xl border border-ink-300 text-ink-700 text-sm hover:bg-ink-100 transition-colors"
                        >
                          إلغاء
                        </button>
                        <button
                          onClick={applyDraft}
                          disabled={applying}
                          className="h-9 px-4 rounded-xl bg-live-600 text-white text-sm flex items-center gap-2 hover:bg-live-700 transition-colors disabled:opacity-50"
                        >
                          {applying ? "جاري التطبيق..." : "تطبيق على النظام"}
                          <Check className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Items grouped by category */}
                {displayDraft.categories.map((cat) => {
                  const items = displayDraft.items.filter((i) => i.category_name === cat.name);
                  if (items.length === 0) return null;
                  return (
                    <div key={cat.name} className="bg-white rounded-2xl shadow-sh-1 overflow-hidden">
                      <div className="bg-ink-50 px-4 py-2 flex items-center gap-2 border-b border-ink-200">
                        <span className={`inline-block w-2 h-2 rounded-full ${confidenceColor(cat.confidence)}`} />
                        <span className="font-bold text-ink-900 font-arabic text-sm">{cat.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${confidenceColor(cat.confidence)}`}>
                          {confidenceLabel(cat.confidence)}
                        </span>
                        <span className="text-ink-400 text-xs mr-auto">{items.length} صنف</span>
                      </div>

                      <div className="divide-y divide-ink-100">
                        {items.map((item, itemIdx) => {
                          const globalIdx = displayDraft.items.indexOf(item);
                          return (
                            <div key={globalIdx} className="p-3 hover:bg-ink-50 transition-colors">
                              <div className="flex items-start gap-3">
                                {!editing && (
                                  <button
                                    onClick={() => moveItem(globalIdx, -1)}
                                    className="p-1 text-ink-300 hover:text-ink-600"
                                    title="تحريك لأعلى"
                                  >
                                    <ChevronUp className="w-4 h-4" />
                                  </button>
                                )}
                                <div className="flex-1 min-w-0 space-y-2">
                                  {editing ? (
                                    <input
                                      type="text"
                                      value={item.ar_name}
                                      onChange={(e) => updateItem(globalIdx, "ar_name", e.target.value)}
                                      className="w-full h-9 px-3 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                                    />
                                  ) : (
                                    <div className="flex items-center gap-2">
                                      <span className="font-arabic font-bold text-ink-900 text-sm">{item.ar_name}</span>
                                      {item.en_name && (
                                        <span className="text-ink-400 text-xs">{item.en_name}</span>
                                      )}
                                    </div>
                                  )}

                                  {!editing && item.modifiers.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                      {item.modifiers.map((m, mi) => (
                                        <span key={mi} className="text-[10px] bg-ink-100 text-ink-600 px-2 py-0.5 rounded-full font-arabic">
                                          {m.ar_name}{m.price_cents > 0 ? ` (+${formatCents(m.price_cents)})` : ""}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>

                                <div className="flex items-center gap-2">
                                  {editing ? (
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      value={formatCents(item.price_cents)}
                                      onChange={(e) => updateItem(globalIdx, "price_cents", parseCents(e.target.value))}
                                      className="w-24 h-9 px-3 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm text-left outline-none focus:border-saffron-500"
                                      dir="ltr"
                                    />
                                  ) : (
                                    <span className="font-mono font-bold text-saffron-600 text-sm whitespace-nowrap">
                                      {formatCents(item.price_cents)}
                                    </span>
                                  )}

                                  {editing && (
                                    <select
                                      value={item.category_name}
                                      onChange={(e) => updateItem(globalIdx, "category_name", e.target.value)}
                                      className="h-9 px-2 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-xs outline-none focus:border-saffron-500"
                                    >
                                      {displayDraft.categories.map((c) => (
                                        <option key={c.name} value={c.name}>{c.name}</option>
                                      ))}
                                    </select>
                                  )}

                                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${confidenceColor(item.confidence)}`}>
                                    {confidenceLabel(item.confidence)}
                                  </span>

                                  {editing && (
                                    <>
                                      <button
                                        onClick={() => addModifier(globalIdx)}
                                        className="p-1.5 rounded-lg text-ink-400 hover:text-saffron-600 hover:bg-saffron-50 transition-colors"
                                        title="إضافة تعديل"
                                      >
                                        <Plus className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        onClick={() => removeItem(itemIdx)}
                                        className="p-1.5 rounded-lg text-ink-400 hover:text-stop-600 hover:bg-stop-50 transition-colors"
                                        title="حذف"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>

                              {/* Modifier editing */}
                              {editing && item.modifiers.length > 0 && (
                                <div className="mr-8 mt-2 space-y-1">
                                  {item.modifiers.map((m, mi) => (
                                    <div key={mi} className="flex items-center gap-2">
                                      <input
                                        type="text"
                                        value={m.ar_name}
                                        onChange={(e) => updateModifier(globalIdx, mi, "ar_name", e.target.value)}
                                        className="h-8 px-2 rounded-lg bg-ink-50 border border-ink-200 text-ink-900 font-arabic text-xs outline-none focus:border-saffron-500 flex-1"
                                        placeholder="اسم التعديل"
                                      />
                                      <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={formatCents(m.price_cents)}
                                        onChange={(e) => updateModifier(globalIdx, mi, "price_cents", parseCents(e.target.value))}
                                        className="w-20 h-8 px-2 rounded-lg bg-ink-50 border border-ink-200 text-ink-900 font-mono text-xs text-left outline-none focus:border-saffron-500"
                                        dir="ltr"
                                      />
                                      <button
                                        onClick={() => removeModifier(globalIdx, mi)}
                                        className="p-1 rounded text-ink-400 hover:text-stop-600"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            /* Empty state */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-ink-400 space-y-4">
                <Camera className="w-20 h-20 mx-auto opacity-20" />
                <h2 className="text-lg font-bold font-arabic text-ink-500">إعداد القائمة بالذكاء الاصطناعي</h2>
                <p className="text-sm font-arabic max-w-md">
                  ارفع صوراً لقائمة الطعام وسيقوم الذكاء الاصطناعي باستخراج الأصناف والأسعار تلقائياً.
                  راجع البيانات وصححها قبل تطبيقها على النظام.
                </p>
                <div className="flex justify-center gap-3">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="h-10 px-6 rounded-xl bg-saffron-600 text-white text-sm flex items-center gap-2 hover:bg-saffron-700 transition-colors"
                  >
                    <Upload className="w-4 h-4" />
                    رفع صور القائمة
                  </button>
                  <button
                    onClick={() => audioInputRef.current?.click()}
                    className="h-10 px-6 rounded-xl border border-ink-300 text-ink-700 text-sm flex items-center gap-2 hover:bg-ink-100 transition-colors"
                  >
                    <Mic className="w-4 h-4" />
                    تسجيل صوتي
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
