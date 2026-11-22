import { IconAlertTriangle, IconCheck, IconX } from "@tabler/icons-react";
import { costClassLabel } from "../../lib/profit";
import { ACCESS_FEATURES, type AccessCell, type PersonCell } from "../../lib/roleAccess";
import {
  accessOf, type AreaGroup, type CategorySalesRow, type CategorySummary,
} from "../../lib/setupOverview";

/** The bodies of the setup overview's sections. Read-only: they show, they never change anything. */

export function AreasBody({ groups }: { groups: AreaGroup[] }) {
  if (groups.length === 0) return <p className="text-ink-500">لا طاولات بعد.</p>;
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.id ?? "none"}>
          <p className="font-bold">{g.name} <span className="text-ink-500 font-normal">({g.tables.length})</span></p>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {g.tables.map((t) => <span key={t.id} className="px-2 py-0.5 rounded-md bg-ink-100 text-ink-900">{t.name}</span>)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CategoriesBody({ rows, itemWord }: { rows: CategorySummary[]; itemWord: string }) {
  const missing = rows.reduce((s, c) => s + c.withoutCost.length, 0);
  if (rows.length === 0) return <p className="text-ink-500">لا أقسام بعد.</p>;
  return (
    <div className="space-y-3">
      {missing > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-warn bg-warn-soft p-3" data-testid="overview-missing-cost">
          <IconAlertTriangle className="w-5 h-5 text-warn shrink-0" />
          {missing} {itemWord} بلا «تكلفة» مُدخلة، فلا يمكن حساب ربحها. أدخل تكلفتها من صفحة القائمة.
        </p>
      )}
      <table className="w-full">
        <thead>
          <tr className="text-ink-400 border-b border-ink-100">
            <th className="text-right p-2 font-medium">القسم</th>
            <th className="text-right p-2 font-medium">تُحسب تكلفته مع</th>
            <th className="text-center p-2 font-medium">العدد</th>
            <th className="text-right p-2 font-medium">بلا تكلفة</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-b border-ink-100">
              <td className="p-2 font-bold">{c.name}</td>
              <td className="p-2">{costClassLabel(c.costClass)}</td>
              <td className="p-2 text-center font-mono">{c.itemCount}</td>
              <td className="p-2 text-warn">{c.withoutCost.join("، ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface IngredientLite {
  id: string;
  name: string;
  unit: string;
  current_stock: number;
  min_stock: number;
}

const num = (n: number) => String(Math.round(n * 100) / 100);

export function IngredientsBody({ rows }: { rows: IngredientLite[] }) {
  if (rows.length === 0) return <p className="text-ink-500">لا مواد بعد.</p>;
  return (
    <table className="w-full">
      <thead>
        <tr className="text-ink-400 border-b border-ink-100">
          <th className="text-right p-2 font-medium">المادة</th>
          <th className="text-right p-2 font-medium">الوحدة</th>
          <th className="text-center p-2 font-medium">المتوفر</th>
          <th className="text-center p-2 font-medium">حد التنبيه</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const low = r.min_stock > 0 && r.current_stock <= r.min_stock;
          return (
            <tr key={r.id} className="border-b border-ink-100">
              <td className="p-2 font-bold">{r.name}</td>
              <td className="p-2">{r.unit}</td>
              <td className={`p-2 text-center font-mono ${low ? "text-danger font-bold" : ""}`}>{num(r.current_stock)}</td>
              <td className="p-2 text-center font-mono text-ink-500">{r.min_stock > 0 ? num(r.min_stock) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function SalesBody({ rows, fmt }: { rows: CategorySalesRow[]; fmt: (cents: number) => string }) {
  if (rows.length === 0) return <p className="text-ink-500">لا مبيعات هذا الشهر بعد.</p>;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.name}>
          <div className="flex items-center justify-between">
            <span className="font-bold">{r.name}</span>
            <span><span className="font-mono">{fmt(r.revenue_cents)}</span> <span className="text-ink-500">({r.pct}%)</span></span>
          </div>
          <div className="h-2 rounded-full bg-ink-100 overflow-hidden"><div className="h-full bg-saffron-600" style={{ width: `${r.pct}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export interface AccessPerson {
  id: string;
  name: string;
  role: string;
}

const ROLE_LABEL: Record<string, string> = { OWNER: "مالك", MANAGER: "مدير", ADMIN: "مدير", CASHIER: "كاشير", SERVER: "كاشير", KITCHEN: "مطبخ", ACCOUNTANT: "محاسب" };

/** Rows = people, columns = the areas of the owner's access table: a tick where the person may. A dot marks their own exception. */
export function AccessBody({ people, matrix, personCells }: { people: AccessPerson[]; matrix: AccessCell[]; personCells: Record<string, PersonCell[]> }) {
  if (people.length === 0) return <p className="text-ink-500">لا موظفين بعد.</p>;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-xs" data-testid="overview-access-grid">
          <thead>
            <tr className="text-ink-400 border-b border-ink-100">
              <th className="text-right p-2 font-medium">الموظف</th>
              {ACCESS_FEATURES.map((f) => <th key={f.key} className="p-2 font-medium text-center min-w-16" title={f.hint}>{f.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id} className="border-b border-ink-100">
                <td className="p-2 whitespace-nowrap"><span className="font-bold">{p.name}</span> <span className="text-ink-500">{ROLE_LABEL[p.role] ?? p.role}</span></td>
                {ACCESS_FEATURES.map((f) => {
                  const a = accessOf(p.role, f, matrix, personCells[p.id]);
                  return (
                    <td key={f.key} className="p-2 text-center" title={a.exception ? "استثناء لهذا الشخص" : undefined}>
                      {a.allowed === null ? <span className="text-ink-300">—</span>
                        : a.allowed ? <IconCheck className="w-4 h-4 text-ok inline" /> : <IconX className="w-4 h-4 text-ink-300 inline" />}
                      {a.exception && <span className="text-saffron-600 font-bold"> •</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-ink-500">✓ يستطيع، ✕ لا يستطيع، • استثناء خاص بهذا الشخص، — لا ينطبق. المالك يستطيع كل شيء.</p>
    </div>
  );
}
