import { create } from "zustand";

interface ShiftState {
  activeShiftId: string | null;
  setActiveShiftId: (id: string | null) => void;
}

export const useShiftStore = create<ShiftState>((set) => ({
  activeShiftId: null,
  setActiveShiftId: (id) => set({ activeShiftId: id }),
}));
