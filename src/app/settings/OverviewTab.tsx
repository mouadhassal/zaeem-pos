import { useMemo } from "react";
import { useTerms } from "../../lib/terms";
import { useCurrency } from "../../hooks/useCurrency";
import { invoke } from "../../lib/invoke";
import { navigateTo } from "../../lib/appNav";
import { periodRange } from "../../lib/dashboard";
import { moduleOn } from "../../lib/businessModules";
import { getRoleAccess, getStaffAccess, type AccessCell, type PersonCell } from "../../lib/roleAccess";
import {
  areaGroups, categorySales, categorySummaries, countWithoutCost,
  type AreaLite, type CategoryLite, type ItemLite, type TableLite,
} from "../../lib/setupOverview";
import { useAuthStore } from "../../stores/authStore";
import { useBusinessStore } from "../../stores/businessStore";
import { usePlanStore } from "../../stores/planStore";
import { settle } from "../dashboard/dashApi";
import { useDashLoad } from "../dashboard/useDashLoad";
import OverviewSection from "./OverviewSection";
import { AccessBody, AreasBody, CategoriesBody, IngredientsBody, SalesBody, type AccessPerson, type IngredientLite } from "./OverviewParts";

interface StaffLite { id: string; name: string; role: string; is_active: number; app_access: boolean }

async function loadAccess(token: string | null): Promise<{ people: AccessPerson[]; matrix: AccessCell[]; personCells: Record<string, PersonCell[]> } | null> {
  const [staff, matrix] = await Promise.all([settle(invoke<StaffLite[]>("list_staff_v3", { sessionToken: token })), settle(getRoleAccess())]);
  if (!staff || !matrix) return null;
  const people = staff.filter((p) => p.app_access && p.is_active === 1 && p.role !== "OWNER" && p.role !== "PLATFORM");
  const cells = await Promise.all(people.map((p) => settle(getStaffAccess(p.id))));
  const personCells: Record<string, PersonCell[]> = {};
  people.forEach((p, i) => { const c = cells[i]; if (c) personCells[p.id] = c; });
  return { people: people.map((p) => ({ id: p.id, name: p.name, role: p.role })), matrix, personCells };
}

/**
 * الإعداد في نظرة: everything the owner set up, in one place, to read and check. Nothing here changes
 * anything; each section has a link to the screen where it is edited.
 */
export default function OverviewTab({ onGoTab }: { onGoTab: (tab: "branch" | "access") => void }) {
  const tm = useTerms();
  const { fmt } = useCurrency();
  const token = useAuthStore((s) => s.token);
  const isOwner = useAuthStore((s) => s.user?.role === "OWNER");
  const modules = useBusinessStore((s) => s.modules);
  const hasTables = useBusinessStore((s) => s.hasTables);
  const posLite = usePlanStore((s) => s.posLite);
  const inventoryOn = !posLite && moduleOn(modules, "inventory");

  const { data, loading } = useDashLoad(async () => {
    const month = periodRange("month");
    const [areas, tables, categories, items, ingredients, engineering, access] = await Promise.all([
      hasTables ? settle(invoke<AreaLite[]>("list_dining_areas_v3", { sessionToken: token })) : Promise.resolve(null),
      hasTables ? settle(invoke<TableLite[]>("list_tables_v3", { sessionToken: token })) : Promise.resolve(null),
      settle(invoke<CategoryLite[]>("list_categories_v3", { sessionToken: token })),
      settle(invoke<ItemLite[]>("list_menu_items_v3", { sessionToken: token })),
      inventoryOn ? settle(invoke<(IngredientLite & { is_active: number })[]>("list_ingredients_v3", { sessionToken: token })) : Promise.resolve(null),
      posLite ? Promise.resolve(null) : settle(invoke<{ categories: { name: string; revenue_cents: number }[] }>("get_menu_engineering_v3", { sessionToken: token, startIso: month.startIso, endIso: month.endIso })),
      isOwner ? loadAccess(token) : Promise.resolve(null),
    ]);
    return { areas, tables, categories, items, ingredients, engineering, access };
  }, [token]);

  const groups = useMemo(() => areaGroups(data?.areas ?? [], data?.tables ?? []), [data]);
  const cats = useMemo(() => categorySummaries(data?.categories ?? [], data?.items ?? []), [data]);
  const sales = useMemo(() => categorySales(data?.engineering?.categories ?? []), [data]);
  const materials = (data?.ingredients ?? []).filter((i) => i.is_active !== 0);
  const itemsCount = cats.reduce((s, c) => s + c.itemCount, 0);
  const missing = countWithoutCost(cats);

  if (loading) return <div className="py-10 text-center text-ink-500 font-arabic">جاري التحميل...</div>;

  return (
    <div className="space-y-4 max-w-4xl" data-testid="settings-overview">
      <div>
        <h2 className="text-lg font-bold text-ink-900 font-arabic">نظرة عامة على الإعداد</h2>
        <p className="text-sm text-ink-500 font-arabic">كل ما أعددته في مكان واحد للمراجعة فقط. لا شيء يتغير من هنا، وبجانب كل قسم رابط يفتح مكان تعديله.</p>
      </div>

      {hasTables && (
        <OverviewSection id="areas" title="الصالات والطاولات" count={`${data?.tables?.length ?? 0} طاولة`}
          editLabel="تعديل الصالات والطاولات" onEdit={() => onGoTab("branch")} unavailable={data?.tables ? undefined : "تعذر قراءة الطاولات."}>
          <AreasBody groups={groups} />
        </OverviewSection>
      )}

      <OverviewSection id="categories" title={`الأقسام و${tm.theItems}`} count={`${cats.length} قسم · ${itemsCount} ${tm.item}${missing > 0 ? ` · ${missing} بلا تكلفة` : ""}`}
        editLabel={`تعديل ${tm.menu}`} onEdit={() => navigateTo("menu")} unavailable={data?.categories ? undefined : `تعذر قراءة ${tm.menu}.`}>
        <CategoriesBody rows={cats} itemWord={tm.item} />
      </OverviewSection>

      {inventoryOn && (
        <OverviewSection id="materials" title="المواد" count={`${materials.length} مادة`}
          editLabel="تعديل المواد" onEdit={() => navigateTo("inventory")} unavailable={data?.ingredients ? undefined : "تعذر قراءة المواد."}>
          <IngredientsBody rows={materials} />
        </OverviewSection>
      )}

      {!posLite && (
        <OverviewSection id="sales" title="المبيعات حسب القسم" count={`هذا الشهر · ${sales.length} قسم`}
          editLabel="فتح تقرير المبيعات" onEdit={() => navigateTo("reports")} unavailable={data?.engineering ? undefined : "لا تملك صلاحية رؤية التقارير."}>
          <SalesBody rows={sales} fmt={fmt} />
        </OverviewSection>
      )}

      <OverviewSection id="access" title="الصلاحيات" count={`${data?.access?.people.length ?? 0} موظف`}
        editLabel={isOwner ? "تعديل الصلاحيات" : undefined} onEdit={isOwner ? () => onGoTab("access") : undefined}
        unavailable={isOwner ? (data?.access ? undefined : "تعذر قراءة الصلاحيات.") : "الصلاحيات يراها المالك وحده."}>
        {data?.access && <AccessBody people={data.access.people} matrix={data.access.matrix} personCells={data.access.personCells} />}
      </OverviewSection>
    </div>
  );
}
