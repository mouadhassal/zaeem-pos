import { create } from "zustand";

// Shared toast/notification system (item 3 of the 2026-09-14 QA audit):
// pos/page.tsx already had a working self-dismissing banner (`successMsg`
// state, used for both success AND error feedback) but no other page had
// any equivalent -- back-office pages (menu/inventory/customers/staff/
// debt/schedule/loyalty) gave zero positive feedback after a successful
// save, the modal just silently closed. This is that pattern, extracted
// into a store so any page can call useToast() without prop-drilling or a
// React Context provider -- one <ToastContainer/> mounted once in App.tsx
// renders whatever's in here regardless of which back-office view is
// currently active.
export type ToastKind = "success" | "error";

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastState {
  toasts: Toast[];
  show: (message: string, kind?: ToastKind, durationMs?: number) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  show: (message, kind = "success", durationMs) => {
    const id = nextId++;
    // Errors stay up longer than success confirmations -- mirrors the
    // durations pos/page.tsx already tuned per-message (2s-2.5s for a quick
    // "added ✓", 4s-5s for a failure that's worth actually reading).
    const duration = durationMs ?? (kind === "error" ? 4500 : 2500);
    set({ toasts: [...get().toasts, { id, message, kind }] });
    setTimeout(() => get().dismiss(id), duration);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
