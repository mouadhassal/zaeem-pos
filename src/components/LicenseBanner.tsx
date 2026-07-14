import { useEffect, useState } from "react";
import { validateLicense, type LicenseStatus } from "../lib/license";
import { AlertTriangle, Clock, Lock, X } from "lucide-react";

interface Props {
  jwt: string;
  onExpired: () => void;
}

interface ChipInfo {
  icon: typeof AlertTriangle;
  text: string;
  color: string;
}

const STATUS_CHIP: Record<string, (days: number) => ChipInfo> = {
  expiring: (d) => ({
    icon: AlertTriangle,
    text: `ينتهي الاشتراك خلال ${d} أيام`,
    color: "amber",
  }),
  grace: () => ({
    icon: Clock,
    text: "فترة سماح: يرجى تجديد الاشتراك",
    color: "orange",
  }),
  expired: () => ({
    icon: Lock,
    text: "الاشتراك منتهي — اتصل بالدعم",
    color: "red",
  }),
};

const COLOR_CLASSES: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  amber: { bg: "bg-amber-500/10", border: "border-amber-500/20", text: "text-amber-600", dot: "bg-amber-500" },
  orange: { bg: "bg-orange-500/10", border: "border-orange-500/20", text: "text-orange-600", dot: "bg-orange-500" },
  red: { bg: "bg-red-500/10", border: "border-red-500/20", text: "text-red-600", dot: "bg-red-500" },
};

export default function LicenseBanner({ jwt, onExpired }: Props) {
  const [status, setStatus] = useState<LicenseStatus>("active");
  const [days, setDays] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    validateLicense(jwt).then((result) => {
      setStatus(result.status);
      setDays(result.daysRemaining);
      if (result.status === "expired") {
        onExpired();
      }
    });
  }, [jwt, onExpired]);

  if (status === "active" || dismissed) return null;

  const chip = STATUS_CHIP[status]?.(days);
  if (!chip) return null;

  const colors = COLOR_CLASSES[chip.color] || COLOR_CLASSES.amber;

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
