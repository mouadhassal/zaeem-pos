import { useState, useRef, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { IconCamera as Camera, IconUpload as Upload, IconMicrophone as Mic, IconCheck as Check, IconX as X, IconChevronUp as ChevronUp, IconRotate as RotateCcw, IconPlus as Plus, IconTrash as Trash2, IconPhoto as ImageIcon } from "@tabler/icons-react";
import { useAuthStore } from "../../stores/authStore";
import { realErrorText } from "../../lib/errors";

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
  if (c >= 0.9) return "text-ok-600 bg-ok-100";
  if (c >= 0.7) return "text-warn-600 bg-warn-100";
  return "text-danger-600 bg-danger-100";
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
  const [dragActive, setDragActive] = useState(false);
  // Keyed by filename -- object URLs created client-side at upload time
  // purely for display (the backend never sends photo bytes back), so a
  // photo strip thumbnail shows the actual picture instead of a generic
  // camera icon.
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  // These invoke() failures used to only console.error -- a non-technical
  // owner dragging in menu photos on a POS terminal (no dev console access)
  // would see a photo silently fail to appear with zero explanation.
  const [uploadError, setUploadError] = useState<string | null>(null);
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
      setUploadError(`تعذر تحميل قائمة الملفات: ${realErrorText(e)}`);
    }
  }, [selectedIdx, token]);

  const handleFiles = async (files: FileList | Array<File> | null, kind: string) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (kind === "PHOTO") {
        setPreviewUrls((prev) => ({ ...prev, [file.name]: URL.createObjectURL(file) }));
      }
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
        setUploadError(`تعذر رفع ${file.name}: ${realErrorText(e)}`);
      }
    }
    await refreshUploads();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) await handleFiles(files, "PHOTO");
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

  // 2026-08-01: the review strip kept every upload ever made forever, with
  // no way to remove one -- clicking X deletes it outright (any status,
  // not just done/failed), same as the request explicitly asked for.
  const removeUpload = async (e: React.MouseEvent, id: string, idx: number) => {
    e.stopPropagation();
    try {
      await invoke("delete_upload", { sessionToken: token, uploadId: id });
      const filename = uploads[idx]?.filename;
      if (filename && previewUrls[filename]) {
        URL.revokeObjectURL(previewUrls[filename]);
        setPreviewUrls((prev) => {
          const next = { ...prev };
          delete next[filename];
          return next;
        });
      }
      if (selectedIdx === idx) {
        setSelectedIdx(null);
        setEditing(false);
        setEditedDraft(null);
      }
      await refreshUploads();
    } catch (err) {
      setUploadError(`تعذر حذف الملف: ${realErrorText(err)}`);
    }
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

  // 2026-08-02: the AI can miss a dish on the source photo -- previously
  // the only way to add it was to apply the draft as-is, then go create
  // the item manually in the Menu page. confidence: 1 marks it as a real,
  // human-entered fact, not a guess needing review (see confidenceColor/
  // confidenceLabel below, which read this same field for every other item).
  const addItem = (categoryName: string) => {
    if (!editedDraft) return;
    const newItem: DraftItem = { ar_name: "", en_name: null, price_cents: 0, category_name: categoryName, modifiers: [], confidence: 1 };
    setEditedDraft({ ...editedDraft, items: [...editedDraft.items, newItem] });
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
      // Once applied, this upload has done its job -- the menu items are
      // real now, no reason for the photo to keep sitting in the review
      // strip forever (that was the actual complaint: uploads piling up
      // with no way to clear them).
      const appliedItem = selectedIdx !== null ? uploads[selectedIdx] : null;
      if (appliedItem) {
        await invoke("delete_upload", { sessionToken: token, uploadId: appliedItem.id });
        setSelectedIdx(null);
        await refreshUploads();
      }
    } catch (e) {
      setApplyResult(`❌ فشل التطبيق: ${e}`);
    } finally {
      setApplying(false);
    }
  };

  const selectedItem = selectedIdx !== null ? uploads[selectedIdx] : null;
  const displayDraft = editing ? editedDraft : selectedItem?.draft_menu ?? null;

  return (
    <div className="h-full flex flex-col overflow-hidden relative" dir="rtl">
      {uploadError && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-danger-100 text-danger-600 text-sm font-arabic rounded-md px-4 py-2 shadow-sh-2 max-w-md text-center">
          {uploadError}
          <button onClick={() => setUploadError(null)} className="mr-2 font-bold">×</button>
        </div>
      )}
      {/* 2026-08-11: matched to the same plain-canvas header pattern every
          other page uses (dashboard/page.tsx) instead of a one-off
          full-bleed saffron bar -- see ai/page.tsx's identical fix. */}
      <header className="bg-canvas border-b border-ink-200 px-6 py-3 flex items-center gap-3 flex-shrink-0">
        <div className="w-9 h-9 rounded-md bg-saffron-50 flex items-center justify-center shrink-0">
          <Camera className="w-4 h-4 text-saffron-600" />
        </div>
        <h1 className="text-xl font-bold text-ink-900">الإعداد الذكي للقائمة</h1>
        <span className="text-ink-400 text-xs">AI Onboarding</span>
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
            className="h-9 px-4 rounded-lg bg-saffron-600 text-white text-sm flex items-center gap-2 hover:bg-saffron-700 transition-colors"
          >
            <Camera className="w-4 h-4" />
            إضافة صور
          </button>
          <button
            onClick={() => audioInputRef.current?.click()}
            className="h-9 px-4 rounded-lg border border-ink-300 text-ink-700 text-sm flex items-center gap-2 hover:bg-ink-100 transition-colors"
          >
            <Mic className="w-4 h-4" />
            تسجيل صوتي
          </button>
          <div className="mr-auto flex items-center gap-3">
            {uploads.length > 0 && !editing && (
              <button
                onClick={processAll}
                disabled={processing}
                className="h-9 px-4 rounded-lg bg-saffron-600 text-white text-sm flex items-center gap-2 hover:bg-saffron-700 transition-colors disabled:opacity-50"
              >
                {processing ? "جاري المعالجة..." : "معالجة الكل"}
              </button>
            )}
            {uploads.some((u) => u.status === "FAILED") && (
              <button
                onClick={async () => { await invoke("reset_failed_uploads", { sessionToken: token }); await refreshUploads(); }}
                className="h-9 px-4 rounded-lg border border-ink-300 text-ink-700 text-sm flex items-center gap-2 hover:bg-ink-100 transition-colors"
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
              <div key={u.id} className="relative flex-shrink-0 group">
                <button
                  onClick={() => selectUpload(i)}
                  className={`w-16 h-16 rounded-lg border-2 transition-all overflow-hidden relative ${
                    selectedIdx === i
                      ? "border-saffron-500 shadow-md"
                      : "border-ink-200 hover:border-ink-400"
                  }`}
                >
                  {u.kind === "PHOTO" && previewUrls[u.filename] ? (
                    <img src={previewUrls[u.filename]} alt={u.filename} className="w-full h-full object-cover" />
                  ) : (
                    <div
                      className={`w-full h-full flex items-center justify-center text-xs font-bold ${
                        u.status === "DONE"
                          ? "bg-ok-100 text-ok-700"
                          : u.status === "FAILED"
                          ? "bg-danger-100 text-danger-700"
                          : u.status === "PROCESSING"
                          ? "bg-warn-100 text-warn-700"
                          : "bg-ink-100 text-ink-500"
                      }`}
                    >
                      {u.kind === "AUDIO" ? <Mic className="w-4 h-4" /> : <ImageIcon className="w-4 h-4" />}
                    </div>
                  )}
                  <div
                    className={`absolute bottom-0 left-0 right-0 text-[8px] text-center leading-tight truncate px-1 py-0.5 ${
                      u.status === "DONE"
                        ? "bg-ok-600/90 text-white"
                        : u.status === "FAILED"
                        ? "bg-danger-600/90 text-white"
                        : u.status === "PROCESSING"
                        ? "bg-warn-500/90 text-white"
                        : "bg-black/50 text-white"
                    }`}
                  >
                    {u.status === "DONE" ? "تم" : u.status === "FAILED" ? "فشل" : u.status === "PROCESSING" ? "جاري..." : "بانتظار"}
                  </div>
                </button>
                <button
                  onClick={(e) => removeUpload(e, u.id, i)}
                  title="إزالة"
                  className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-danger-600 text-white flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity hover:bg-danger-700"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main content area */}
        <div className="flex-1 flex overflow-hidden">
          {selectedItem && displayDraft ? (
            <>
              {/* Photo preview */}
              <div className="w-1/3 border-l border-ink-200 bg-ink-50 p-4 flex items-center justify-center overflow-hidden">
                {selectedItem.kind === "PHOTO" && previewUrls[selectedItem.filename] ? (
                  <div className="w-full h-full flex flex-col gap-2">
                    <img
                      src={previewUrls[selectedItem.filename]}
                      alt={selectedItem.filename}
                      className="w-full flex-1 object-contain rounded-lg border border-ink-200 bg-white"
                    />
                    {selectedItem.error && (
                      <p className="text-xs text-danger-600 text-center font-arabic">{selectedItem.error}</p>
                    )}
                  </div>
                ) : (
                  <div className="text-center text-ink-400">
                    <Camera className="w-16 h-16 mx-auto mb-2 opacity-30" />
                    <p className="text-sm font-arabic">معاينة الصورة</p>
                    {selectedItem.error && (
                      <p className="text-xs text-danger-600 mt-2 font-arabic">{selectedItem.error}</p>
                    )}
                  </div>
                )}
              </div>

              {/* Extraction results */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {editing && applyResult && (
                  <div className="px-4 py-3 rounded-lg bg-ok-100 text-ok-800 text-sm font-arabic">{applyResult}</div>
                )}

                <div className="flex items-center justify-between">
                  <h2 className="font-bold text-ink-900 text-lg font-arabic">
                    {editing ? "تعديل البيانات المستخرجة" : "البيانات المستخرجة"}
                  </h2>
                  <div className="flex gap-2">
                    {!editing && selectedItem.status === "DONE" && (
                      <button
                        onClick={startEditing}
                        className="h-9 px-4 rounded-lg bg-saffron-600 text-white text-sm hover:bg-saffron-700 transition-colors"
                      >
                        تعديل
                      </button>
                    )}
                    {editing && (
                      <>
                        <button
                          onClick={() => { setEditing(false); setEditedDraft(null); setApplyResult(null); }}
                          className="h-9 px-4 rounded-lg border border-ink-300 text-ink-700 text-sm hover:bg-ink-100 transition-colors"
                        >
                          إلغاء
                        </button>
                        <button
                          onClick={applyDraft}
                          disabled={applying}
                          className="h-9 px-4 rounded-lg bg-saffron-600 text-white text-sm flex items-center gap-2 hover:bg-saffron-700 transition-colors disabled:opacity-50"
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
                    <div key={cat.name} className="bg-white rounded-lg border border-ink-200 overflow-hidden shadow-sh-1">
                      <div className="bg-ink-50 px-4 py-2 flex items-center gap-2 border-b border-ink-200">
                        <span className={`inline-block w-2 h-2 rounded-full ${confidenceColor(cat.confidence)}`} />
                        <span className="font-bold text-ink-900 font-arabic text-sm">{cat.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${confidenceColor(cat.confidence)}`}>
                          {confidenceLabel(cat.confidence)}
                        </span>
                        <span className="text-ink-400 text-xs mr-auto">{items.length} صنف</span>
                        {editing && (
                          <button
                            onClick={() => addItem(cat.name)}
                            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-full text-saffron-700 bg-saffron-50 hover:bg-saffron-100 transition-colors"
                            title="إضافة صنف فاتته الأداة"
                          >
                            <Plus className="w-3 h-3" /> إضافة صنف
                          </button>
                        )}
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
                                      className="w-full h-9 px-3 rounded-lg bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
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
                                      className="w-24 h-9 px-3 rounded-lg bg-white border border-ink-200 text-ink-900 font-mono text-sm text-left outline-none focus:border-saffron-500"
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
                                      className="h-9 px-2 rounded-lg bg-white border border-ink-200 text-ink-900 font-arabic text-xs outline-none focus:border-saffron-500"
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
                                        className="p-1.5 rounded-lg text-ink-400 hover:text-danger-600 hover:bg-danger-50 transition-colors"
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
                                        className="p-1 rounded text-ink-400 hover:text-danger-600"
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
            /* Empty state -- a real drop zone, not just an icon + buttons */
            <div className="flex-1 flex items-center justify-center p-8">
              <div
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                className={`w-full max-w-xl rounded-lg border-2 border-dashed transition-colors p-10 text-center space-y-4 ${
                  dragActive ? "border-saffron-500 bg-saffron-50" : "border-ink-300 bg-white"
                }`}
              >
                <Upload className={`w-14 h-14 mx-auto ${dragActive ? "text-saffron-500" : "text-ink-300"}`} />
                <div>
                  <h2 className="text-lg font-bold font-arabic text-ink-700">اسحب صور القائمة هنا</h2>
                  <p className="text-sm font-arabic text-ink-400 mt-1 max-w-md mx-auto">
                    أو اضغط للاختيار من جهازك. سيقوم الذكاء الاصطناعي باستخراج الأصناف والأسعار تلقائياً،
                    ويمكنك مراجعتها وتصحيحها قبل تطبيقها على النظام.
                  </p>
                </div>
                <div className="flex justify-center gap-3 pt-1">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="h-10 px-6 rounded-lg bg-saffron-600 text-white text-sm flex items-center gap-2 hover:bg-saffron-700 transition-colors"
                  >
                    <Camera className="w-4 h-4" />
                    اختيار الصور
                  </button>
                  <button
                    onClick={() => audioInputRef.current?.click()}
                    className="h-10 px-6 rounded-lg border border-ink-300 text-ink-700 text-sm flex items-center gap-2 hover:bg-ink-100 transition-colors"
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
