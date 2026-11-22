import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import { monthLabel, type AdvanceRow, type EmployeeRow, type WorkerStatement } from "../../lib/payroll";
import { Field, Hint, Modal, btnGhost, btnPrimary, inputCls } from "./ui";

/** A worker's account: every advance given, every instalment taken off a payslip, and what is still owed. */
function StatementModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const token = useAuthStore((s) => s.token);
  const [st, setSt] = useState<WorkerStatement | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    invoke<WorkerStatement>("get_worker_statement_v3", { sessionToken: token, userId }).then(setSt).catch((e) => setError(realErrorText(e)));
  }, [token, userId]);
  return (
    <Modal title={st ? `كشف حساب ${st.user_name}` : "كشف الحساب"} onClose={onClose} wide>
      {error && <p className="text-danger font-arabic text-sm">{error}</p>}
      {!st && !error && <p className="text-ink-500 font-arabic">جاري التحميل...</p>}
      {st && (
        <div className="space-y-4" data-testid="worker-statement">
          <div className="grid grid-cols-3 gap-2 text-center font-arabic">
            <div className="rounded-md border border-ink-200 p-2.5"><p className="text-[11px] text-ink-400">سلف مُعطاة</p><p className="font-mono font-bold">{formatMoney(st.total_advanced_cents)}</p></div>
            <div className="rounded-md border border-ink-200 p-2.5"><p className="text-[11px] text-ink-400">سُدّد من الرواتب</p><p className="font-mono font-bold text-ok">{formatMoney(st.total_repaid_cents)}</p></div>
            <div className="rounded-md border border-ink-200 p-2.5"><p className="text-[11px] text-ink-400">المتبقي عليه</p><p className={`font-mono font-bold ${st.owed_cents > 0 ? "text-danger" : "text-ink-400"}`} data-testid="statement-owed">{formatMoney(st.owed_cents)}</p></div>
          </div>
          <table className="w-full text-sm font-arabic">
            <thead><tr className="border-b border-ink-200 text-ink-400"><th className="text-right p-2 font-medium">التاريخ</th><th className="text-right p-2 font-medium">البيان</th><th className="text-center p-2 font-medium">المبلغ</th><th className="text-center p-2 font-medium">الرصيد عليه</th></tr></thead>
            <tbody>
              {st.lines.map((l, i) => (
                <tr key={i} className="border-b border-ink-100">
                  <td className="p-2 font-mono text-ink-500" dir="ltr">{l.date}</td>
                  <td className="p-2">{l.label}</td>
                  <td className={`p-2 text-center font-mono ${l.amount_cents > 0 ? "text-danger" : "text-ok"}`} dir="ltr">{l.amount_cents > 0 ? "+" : "-"}{formatMoney(Math.abs(l.amount_cents))}</td>
                  <td className="p-2 text-center font-mono">{formatMoney(l.balance_cents)}</td>
                </tr>
              ))}
              {st.lines.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-ink-500">لا سلف على هذا الموظف.</td></tr>}
            </tbody>
          </table>
          {st.payslips.length > 0 && (
            <div className="space-y-1">
              <h3 className="font-bold font-arabic text-ink-900 text-sm">رواتبه المعتمدة</h3>
              {st.payslips.map((p) => (
                <div key={p.month} className="flex justify-between text-xs font-arabic border-b border-ink-100 py-1">
                  <span>{monthLabel(p.month)}</span>
                  <span className="font-mono" dir="ltr">المستحق {formatMoney(p.earned_cents)} · قسط سلفة {formatMoney(p.advance_repaid_cents)} · الصافي {formatMoney(p.net_cents)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Salary advances and how much of each is still to be taken back. */
export default function AdvancesTab({ employees }: { employees: EmployeeRow[] }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [rows, setRows] = useState<AdvanceRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [userId, setUserId] = useState("");
  const [amount, setAmount] = useState("");
  const [instalment, setInstalment] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [statementOf, setStatementOf] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await invoke<AdvanceRow[]>("list_payroll_advances_v3", { sessionToken: token, userId: null }));
    } catch (err) {
      toast.error(realErrorText(err));
    }
  }, [token, toast]);
  useEffect(() => { load(); }, [load]);

  const nameOf = (id: string) => employees.find((e) => e.user_id === id)?.name ?? "—";

  const add = async () => {
    setBusy(true);
    try {
      await invoke("add_payroll_advance_v3", {
        sessionToken: token, userId, amountCents: parseMoneyInput(amount), instalmentCents: parseMoneyInput(instalment),
        givenOn: new Date().toISOString().slice(0, 10), reason: reason || null,
      });
      toast.success("سُجّلت السلفة");
      setAdding(false); setAmount(""); setInstalment(""); setReason("");
      load();
    } catch (err) {
      toast.error(realErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await invoke("cancel_payroll_advance_v3", { sessionToken: token, advanceId: id });
      toast.success("أُلغيت السلفة");
      load();
    } catch (err) {
      toast.error(realErrorText(err));
    }
  };

  return (
    <div className="space-y-4" data-testid="advances-tab">
      <div className="flex items-start justify-between gap-4">
        <Hint summary="السلفة مبلغ يأخذه الموظف الآن ويُخصم على أقساط من رواتبه القادمة.">
          <p>القسط يُؤخذ تلقائياً عند اعتماد كل راتب حتى تنتهي السلفة، ولا يتجاوز ما استحقه الموظف في ذلك الشهر.</p>
          <p>السلفة تُسجَّل مرة واحدة: تسجيلها هنا يضيفها إلى مصروفات المالية (سلفة موظف)، وتسجيلها من المالية يضيفها هنا. لا تسجّلها من الجهتين.</p>
          <p>السلفة التي بدأ تسديدها لا تُلغى. أما التي سُجّلت بالخطأ ولم يُؤخذ منها شيء فيمكن إلغاؤها.</p>
        </Hint>
        <button onClick={() => { setAdding(true); setUserId(employees[0]?.user_id ?? ""); }} className={btnPrimary} data-testid="advance-new">+ سلفة جديدة</button>
      </div>
      <div className="zc-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
              <th className="text-right p-3 font-medium">الموظف</th>
              <th className="text-right p-3 font-medium">التاريخ</th>
              <th className="text-center p-3 font-medium">المبلغ</th>
              <th className="text-center p-3 font-medium">القسط</th>
              <th className="text-center p-3 font-medium">سُدّد</th>
              <th className="text-center p-3 font-medium">المتبقي</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-b border-ink-100">
                <td className="p-3 font-arabic font-medium">{nameOf(a.user_id)}</td>
                <td className="p-3 font-mono text-ink-500" dir="ltr">{a.given_on}</td>
                <td className="p-3 text-center font-mono">{formatMoney(a.amount_cents)}</td>
                <td className="p-3 text-center font-mono text-ink-500">{formatMoney(a.instalment_cents)}</td>
                <td className="p-3 text-center font-mono text-ok">{formatMoney(a.repaid_cents)}</td>
                <td className={`p-3 text-center font-mono font-bold ${a.remaining_cents > 0 ? "text-danger" : "text-ink-400"}`}>{a.remaining_cents > 0 ? formatMoney(a.remaining_cents) : "منتهية"}</td>
                <td className="p-3 text-left whitespace-nowrap">
                  <button onClick={() => setStatementOf(a.user_id)} className="text-saffron-600 text-xs font-bold font-arabic ml-3" data-testid={`statement-${a.id}`}>كشف حساب</button>
                  {a.repaid_cents === 0 && <button onClick={() => cancel(a.id)} className="text-danger text-xs font-arabic">إلغاء</button>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-ink-500 font-arabic">لا توجد سلف.</td></tr>}
          </tbody>
        </table>
      </div>
      {statementOf && <StatementModal userId={statementOf} onClose={() => setStatementOf(null)} />}
      {adding && (
        <Modal title="سلفة جديدة" onClose={() => setAdding(false)}>
          <Field label="الموظف">
            <select value={userId} onChange={(e) => setUserId(e.target.value)} className={inputCls}>
              {employees.map((e) => <option key={e.user_id} value={e.user_id}>{e.name}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="مبلغ السلفة"><input value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} dir="ltr" inputMode="numeric" /></Field>
            <Field label="القسط الشهري" hint="الجزء الذي يُخصم من كل راتب."><input value={instalment} onChange={(e) => setInstalment(e.target.value)} className={inputCls} dir="ltr" inputMode="numeric" /></Field>
          </div>
          <Field label="السبب (اختياري)"><input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} /></Field>
          <div className="flex justify-end gap-3">
            <button onClick={() => setAdding(false)} className={btnGhost}>إلغاء</button>
            <button onClick={add} disabled={busy || !userId} className={btnPrimary}>{busy ? "جاري..." : "تسجيل"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
