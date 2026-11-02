import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import type { AdvanceRow, EmployeeRow } from "../../lib/payroll";
import { Field, Hint, Modal, btnGhost, btnPrimary, inputCls } from "./ui";

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
                <td className="p-3 text-left">{a.repaid_cents === 0 && <button onClick={() => cancel(a.id)} className="text-danger text-xs font-arabic">إلغاء</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-ink-500 font-arabic">لا توجد سلف.</td></tr>}
          </tbody>
        </table>
      </div>
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
