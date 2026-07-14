import { create } from "zustand";

export interface Printer {
  id: string;
  name: string;
  printerType: "RECEIPT" | "KITCHEN" | "LABEL";
  interface: "USB" | "NETWORK" | "BLUETOOTH";
  vendorId: string | null;
  productId: string | null;
  ipAddress: string | null;
  port: number;
  paperWidthMm: number;
  codePage: string;
  drawerPulseMs: number;
  isPrimary: number;
  isSecondary: number;
  isActive: number;
}

interface PrinterState {
  printers: Printer[];
  setPrinters: (printers: Printer[]) => void;
  addPrinter: (printer: Printer) => void;
  removePrinter: (id: string) => void;
  updatePrinter: (id: string, updates: Partial<Printer>) => void;
}

export const usePrinterStore = create<PrinterState>((set) => ({
  printers: [],
  setPrinters: (printers) => set({ printers }),
  addPrinter: (printer) => set((s) => ({ printers: [...s.printers, printer] })),
  removePrinter: (id) => set((s) => ({ printers: s.printers.filter((p) => p.id !== id) })),
  updatePrinter: (id, updates) =>
    set((s) => ({
      printers: s.printers.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),
}));
