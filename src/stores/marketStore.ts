import { create } from "zustand";
import { EMPTY_MARKET_STATUS, type MarketStatus } from "../lib/marketSync";

/** What the last marketplace round found (written by `useMarketSync`, read by the bell and the stock screen). */
interface MarketState {
  status: MarketStatus;
  setStatus: (s: MarketStatus) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  status: EMPTY_MARKET_STATUS,
  setStatus: (status) => set({ status }),
}));
