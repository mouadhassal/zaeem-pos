import { useState, lazy, Suspense, useEffect } from "react";
import { useAuthStore } from "./stores/authStore";
import LoginPage from "./components/LoginPage";
import SetupWizard from "./components/SetupWizard";
import SessionExpiredOverlay from "./components/SessionExpiredOverlay";
import Sidebar from "./components/layout/Sidebar";
import TopBar from "./components/layout/TopBar";
import LicenseBanner from "./components/LicenseBanner";
import { backOfficeLocked, type LicenseStatus } from "./lib/license";
import { IconLock } from "@tabler/icons-react";
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
const AIPage = lazy(() => import("./app/ai/page"));
const AiOnboardingPage = lazy(() => import("./app/ai-onboarding/page"));
const LoyaltyPage = lazy(() => import("./app/loyalty/page"));

const DebugPage = import.meta.env.DEV
  ? lazy(() => import("./app/debug/page"))
  : null;

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full text-text-muted text-sm">
      جاري التحميل...
    </div>
  );
}

function PosLayout({ children }: { children: React.ReactNode }) {
  const [activeView, setActiveView] = useState("pos");
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const { navItems } = usePermissions();

  const handleNavigate = (id: string) => {
    if (id === "debug") {
      if (import.meta.env.DEV) {
        setActiveView("debug");
      }
      return;
    }
    const item = navItems.find((n) => n.id === id);
    if (item && item.allowed) {
      setActiveView(id);
    }
  };

  // POS never locks, regardless of license status -- a dinner service is
  // never interrupted. Every other screen (back-office/reports) locks once
  // the license is past grace or invalid, per the licensing spec. Settings
  // is also excluded from this blanket lock -- it's where Settings ->
  // License lives, the only place a locked device can paste a new
  // activation key. SettingsPage itself gates its OTHER tabs individually
  // when locked, so nothing except the license tab becomes reachable.
  const locked = activeView !== "pos" && activeView !== "settings" && licenseStatus !== null && backOfficeLocked(licenseStatus);

  const renderContent = () => {
    if (locked) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center gap-3 px-6">
          <IconLock className="w-10 h-10 text-text-muted" stroke={1.5} />
          <p className="text-base font-medium text-text">هذه الشاشة مقفلة — الترخيص منتهي</p>
          <p className="text-sm text-text-muted max-w-sm">
            نقطة البيع تعمل بشكل طبيعي. لإعادة فتح الإدارة والتقارير، جدّد الترخيص من المالك أو المندوب.
          </p>
        </div>
      );
    }
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
      case "ai-onboarding": return <AiOnboardingPage />;
      case "settings": return <SettingsPage />;
      case "debug": return DebugPage ? <DebugPage /> : null;
      default: return children;
    }
  };

  return (
    <div className="h-screen w-screen bg-canvas flex flex-col overflow-hidden">
      {import.meta.env.DEV && (
        <div className="bg-warn text-white text-center text-xs py-1 px-4 font-bold">
          وضع التطوير — حسابات الاختبار متاحة (admin123)
        </div>
      )}
      <TopBar />
      <div className="px-4">
        <LicenseBanner onStatusChange={setLicenseStatus} />
      </div>
      <div className="flex flex-1 overflow-hidden">
        <Sidebar active={activeView} onNavigate={handleNavigate} />
        <main className="flex-1 overflow-hidden bg-canvas">
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
  const needsSetup = useAuthStore((s) => s.needsSetup);
  const checkNeedsSetup = useAuthStore((s) => s.checkNeedsSetup);

  useEffect(() => {
    checkNeedsSetup();
  }, [checkNeedsSetup]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas">
        <div className="w-8 h-8 rounded-full border-2 border-line border-t-accent animate-spin" />
      </div>
    );
  }

  if (needsSetup) {
    return <SetupWizard />;
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <>
      <SessionExpiredOverlay />
      <PosLayout>
        <POSPage />
      </PosLayout>
    </>
  );
}
