import { useEffect, useState } from "react";
import { checkLicense, startLicensePolling, type LicenseStatus } from "../lib/license";
import { AlertTriangle, Clock, Lock, X } from "lucide-react";

interface Props {
  /** Fires whenever the resolved status changes, so a parent (PosLayout)
   * can gate back-office navigation without duplicating the check/poll logic. */
  onStatusChange?: (status: LicenseStatus) => void;
}

interface ChipInfo {
  icon: typeof AlertTriangle;
  text: string;
  color: "orange" | "red";
}

function chipFor(status: LicenseStatus): ChipInfo | null {
  switch (status.kind) {
    case "Active":
      return null;
    case "Grace":
      return { icon: Clock, text: `فترة سماح: يرجى تجديد الترخيص خلال ${status.days_left_in_grace} أيام`, color: "orange" };
    case "LockedBackOffice":
      return { icon: Lock, text: "الترخيص منتهي — الإدارة والتقارير مقفلة. نقطة البيع تعمل بشكل طبيعي.", color: "red" };
    case "Invalid":
      return { icon: Lock, text: "لا يوجد ترخيص صالح — الإدارة والتقارير مقفلة. نقطة البيع تعمل بشكل طبيعي.", color: "red" };
  }
}

const COLOR_CLASSES: Record<string, { bg: string; border: string; text: string }> = {
  orange: { bg: "bg-amber-500/10", border: "border-amber-500/20", text: "text-amber-600" },
  red: { bg: "bg-red-500/10", border: "border-red-500/20", text: "text-red-600" },
};

export default function LicenseBanner({ onStatusChange }: Props) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    checkLicense().then((result) => {
      if (cancelled) return;
      setStatus(result);
      onStatusChange?.(result);
    }).catch(() => {});

    const stopPolling = startLicensePolling();
    return () => { cancelled = true; stopPolling(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!status || dismissed) return null;

  // Locked cases render the full lock screen in PosLayout too -- this chip
  // is just the always-visible nag so a cashier knows to tell the owner,
  // dismissible per-session since the lock screen itself isn't.
  const chip = chipFor(status);
  if (!chip) return null;

  const colors = COLOR_CLASSES[chip.color];

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${colors.bg} ${colors.border} border`}>
      <chip.icon className={`w-3.5 h-3.5 ${colors.text}`} />
      <span className={`text-xs ${colors.text}`}>{chip.text}</span>
      <button onClick={() => setDismissed(true)} className={`mr-0.5 hover:opacity-70 ${colors.text}`}>
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
