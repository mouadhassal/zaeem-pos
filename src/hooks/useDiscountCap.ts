import { useState, useEffect } from "react";
import { invoke } from "../lib/invoke";
import { useAuthStore } from "../stores/authStore";

interface DiscountCaps {
  cashier_percent: number;
  manager_percent: number;
  owner_percent: number;
}

interface DiscountCapsResponse {
  caps: DiscountCaps;
  your_cap_percent: number;
}

// Real, tenant-configurable, server-enforced caps (chain_config via
// get_discount_caps_v3) -- replaces the old `getMaxDiscountPercent(role)`
// frontend constant, which was never checked by Rust and so was purely
// decorative. This hook is affordance only: showing/disabling in the UI.
// The actual enforcement lives in pricing.rs and runs again, for real,
// inside create_order_v3/create_full_order_v3 regardless of what this
// returns.
export function useDiscountCap() {
  const [yourCapPercent, setYourCapPercent] = useState(10);
  const [caps, setCaps] = useState<DiscountCaps | null>(null);

  useEffect(() => {
    const token = useAuthStore.getState().token;
    invoke<DiscountCapsResponse>("get_discount_caps_v3", { sessionToken: token })
      .then((res) => {
        setYourCapPercent(res.your_cap_percent);
        setCaps(res.caps);
      })
      .catch(() => {});
  }, []);

  return { yourCapPercent, caps };
}
