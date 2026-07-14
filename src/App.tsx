import { useState, lazy, Suspense, useEffect } from "react";
import { useAuthStore } from "./stores/authStore";
import LoginPage from "./components/LoginPage";
import Sidebar from "./components/layout/Sidebar";
import TopBar from "./components/layout/TopBar";
import { usePermissions } from "./hooks/usePermissions";

const POSPage = lazy(() => import("./app/pos/page"));
const ReportsPage = lazy(() => import("./app/reports/page"));
const ShiftPage = lazy(() => import("./app/shift/page"));
const MenuPage = lazy(() => import("./app/menu/page"));
const InventoryPage = lazy(() => import("./app/inventory/page"));
const StaffPage = lazy(() => import("./app/staff/page"));
const DebtPage = lazy(() => import("./app/debt/page"));
const CustomersPage = lazy(() => import("./app/customers/page"));
const KDSPage = lazy(() => import("./app/kds/page"));
const BranchesPage = lazy(() => import("./app/branches/page"));
const FinancePage = lazy(() => import("./app/finance/page"));
const DeliveryPage = lazy(() => import("./app/delivery/page"));
const SettingsPage = lazy(() => import("./app/settings/page"));
const DebugPage = lazy(() => import("./app/debug/page"));
const AIPage = lazy(() => import("./app/ai/page"));
const LoyaltyPage = lazy(() => import("./app/loyalty/page"));

function LoadingFallback() {
  return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
      جاري التحميل...
    </div>
  );
}

function PosLayout({ children }: { children: React.ReactNode }) {
  const [activeView, setActiveView] = useState("pos");
  const { navItems } = usePermissions();

  const handleNavigate = (id: string) => {
    if (id === "debug") {
      setActiveView("debug");
      return;
    }
    const item = navItems.find((n) => n.id === id);
    if (item && item.allowed) {
      setActiveView(id);
    }
  };

  const renderContent = () => {
    switch (activeView) {
      case "pos": return children;
      case "reports": return <ReportsPage />;
      case "shift": return <ShiftPage />;
      case "menu": return <MenuPage />;
      case "inventory": return <InventoryPage />;
      case "staff": return <StaffPage />;
      case "debt": return <DebtPage />;
      case "kds": return <KDSPage />;
      case "customers": return <CustomersPage />;
      case "delivery": return <DeliveryPage />;
      case "branches": return <BranchesPage />;
      case "finance": return <FinancePage />;
      case "loyalty": return <LoyaltyPage />;
      case "ai": return <AIPage />;
      case "settings": return <SettingsPage />;
      case "debug": return <DebugPage />;
      default: return children;
    }
  };

  return (
    <div className="h-screen w-screen bg-slate-50 flex flex-col overflow-hidden">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar active={activeView} onNavigate={handleNavigate} />
        <main className="flex-1 overflow-hidden bg-slate-50">
          <Suspense fallback={<LoadingFallback />}>
            {renderContent()}
          </Suspense>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const checkSession = useAuthStore((s) => s.checkSession);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-8 h-8 border-4 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <PosLayout>
      <POSPage />
    </PosLayout>
  );
}
