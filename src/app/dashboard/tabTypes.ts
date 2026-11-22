import type { DashPeriod, DashRange } from "../../lib/dashboard";

/** What every tab gets: the shared period and which of its cards this person may see. */
export interface TabProps {
  period: DashPeriod;
  range: DashRange;
  show: (cardId: string) => boolean;
  /** Opens the detailed report a card leads to. */
  open: (cardId: string) => void;
  /** Bumped by the refresh button. */
  refreshKey: number;
}
