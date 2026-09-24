import { useEffect, useState } from "react";
import { checkLicense, startLicensePolling, LICENSE_CHANGED_EVENT, type LicenseStatus } from "../lib/license";
import { IconAlertTriangle as AlertTriangle, IconClock as Clock, IconLock as Lock, IconX as X } from "@tabler/icons-react";

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
      // The cloud check reports an admin pause as "revoked by cloud: suspended".
      if (/suspended/.test(status.reason)) {
        return { icon: Lock, text: "الحساب موقوف مؤقتاً — الإدارة والتقارير مقفلة. نقطة البيع تعمل بشكل طبيعي. تواصل مع WENZDES.", color: "red" };
      }
      return { icon: Lock, text: "لا يوجد ترخيص صالح — الإدارة والتقارير مقفلة. نقطة البيع تعمل بشكل طبيعي.", color: "red" };
  }
}

const COLOR_CLASSES: Record<string, { bg: string; border: string; text: string }> = {
  orange: { bg: "bg-warn/10", border: "border-warn/20", text: "text-warn" },
  red: { bg: "bg-danger/10", border: "border-danger/20", text: "text-danger" },
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

    const onChanged = (e: Event) => {
      const next = (e as CustomEvent<LicenseStatus>).detail;
      setStatus(next);
      setDismissed(false);
      onStatusChange?.(next);
    };
    window.addEventListener(LICENSE_CHANGED_EVENT, onChanged);
    const stopPolling = startLicensePolling();
    return () => { cancelled = true; stopPolling(); window.removeEventListener(LICENSE_CHANGED_EVENT, onChanged); };
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
