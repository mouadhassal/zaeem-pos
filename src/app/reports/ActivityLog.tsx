import { useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { formatArabicDateTime } from "../../lib/dateLocal";
import { Card, ExportButtons, Note, TABLE, THEAD, Th, useReport, type ReportRange } from "./ReportParts";

interface ActivityRow {
  id: string;
  ts: string;
  actor_id: string;
  actor_name: string;
  action: string;
  kind: string;
  kind_label: string;
  text: string;
  detail: string | null;
}

interface ActivityData {
  rows: ActivityRow[];
  truncated: boolean;
  actors: { id: string; name: string }[];
}

const KIND_TONE: Record<string, string> = {
  cancel: "bg-danger-soft text-danger",
  void: "bg-danger-soft text-danger",
  refund: "bg-danger-soft text-danger",
  discount: "bg-warn-soft text-warn",
  gift: "bg-warn-soft text-warn",
  price: "bg-accent-soft text-accent-text",
  permission: "bg-accent-soft text-accent-text",
  override: "bg-warn-soft text-warn",
};

/** "سجل النشاط": every sensitive action in plain Arabic -- who, when, what. Owner only; nothing here can be changed. */
export default function ActivityLog({ range }: { range: ReportRange }) {
  const token = useAuthStore((s) => s.token);
  const [kinds, setKinds] = useState<[string, string][]>([]);
  const [actorId, setActorId] = useState("");
  const [kind, setKind] = useState("");

  useEffect(() => {
    invoke<[string, string][]>("list_activity_kinds_v3", { sessionToken: token }).then(setKinds).catch(() => setKinds([]));
  }, [token]);

  const { data, error, loading } = useReport<ActivityData>("list_activity_log_v3", range, { actorId: actorId || null, kind: kind || null, limit: 500 });

  const rows = data?.rows ?? [];
  const exportRows = rows.map((r) => [formatArabicDateTime(new Date(r.ts)), r.actor_name, r.kind_label, r.text, r.detail ?? ""]);

  return (
    <Card
      title="سجل النشاط"
      hint="كل عملية حساسة جرت على النظام: من فعلها ومتى وماذا تغيّر. السجل للقراءة فقط ولا يمكن تعديله أو حذف شيء منه."
      testId="activity-log"
      actions={<ExportButtons title="سجل النشاط" filename="سجل-النشاط" headers={["الوقت", "من", "النوع", "ما حدث", "تفاصيل"]} rows={exportRows} />}
    >
      <div className="flex flex-wrap gap-3 text-xs text-ink-500 font-arabic">
        <label className="flex items-center gap-1.5">
          الشخص
          <select value={actorId} onChange={(e) => setActorId(e.target.value)} data-testid="activity-actor" className="h-9 px-2 rounded-sm border border-ink-200 bg-white text-sm text-ink-900">
            <option value="">الكل</option>
            {(data?.actors ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          نوع العملية
          <select value={kind} onChange={(e) => setKind(e.target.value)} data-testid="activity-kind" className="h-9 px-2 rounded-sm border border-ink-200 bg-white text-sm text-ink-900">
            <option value="">الكل</option>
            {kinds.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
      </div>
      {error && <Note tone="error">{error}</Note>}
      {loading && !data && <Note>جاري التحميل...</Note>}
      {data && rows.length === 0 && <Note>لا توجد عمليات مطابقة في هذه الفترة</Note>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead className={THEAD}><tr><Th>الوقت</Th><Th>من</Th><Th>النوع</Th><Th>ما حدث</Th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-ink-100 align-top" data-testid="activity-row">
                  <td className="p-2 whitespace-nowrap text-ink-500">{formatArabicDateTime(new Date(r.ts))}</td>
                  <td className="p-2 font-bold text-ink-900 whitespace-nowrap">{r.actor_name}</td>
                  <td className="p-2 whitespace-nowrap"><span className={`px-2 py-0.5 rounded-full text-xs font-bold ${KIND_TONE[r.kind] ?? "bg-surface-alt text-ink-500"}`}>{r.kind_label}</span></td>
                  <td className="p-2">
                    {r.text}
                    {r.detail && <span className="block text-xs text-ink-400 mt-0.5">{r.detail}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.truncated && <Note>تظهر أحدث 500 عملية فقط. ضيّق الفترة أو اختر شخصاً أو نوعاً لترى الباقي.</Note>}
    </Card>
  );
}
