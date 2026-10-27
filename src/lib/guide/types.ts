export type GuideRole = "CASHIER" | "KITCHEN" | "MANAGER" | "OWNER" | "ACCOUNTANT";

export const ALL_ROLES: GuideRole[] = ["CASHIER", "KITCHEN", "MANAGER", "OWNER", "ACCOUNTANT"];
/** Everyone who sells at the till. */
export const TILL_ROLES: GuideRole[] = ["CASHIER", "MANAGER", "OWNER", "ACCOUNTANT"];
export const BACK_OFFICE_ROLES: GuideRole[] = ["MANAGER", "OWNER"];

export interface GuideTask {
  id: string;
  title: string;
  /** One line: when you need this. */
  when?: string;
  /** Numbered, in the order the person does them. */
  steps?: string[];
  /** Bulleted facts that are not a sequence. */
  points?: string[];
  tips?: string[];
  warnings?: string[];
  /** Not in POS Lite (the Full plan only). */
  fullOnly?: boolean;
}

export interface GuideChapter {
  id: string;
  title: string;
  blurb: string;
  roles: GuideRole[];
  /** The sidebar page this chapter explains, when there is one. */
  page?: string;
  /** The whole chapter is not in POS Lite. */
  fullOnly?: boolean;
  tasks: GuideTask[];
}
