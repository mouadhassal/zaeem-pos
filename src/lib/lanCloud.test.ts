import { beforeEach, describe, expect, it, vi } from "vitest";

// A till that joined over the internet is a satellite with an EMPTY hub address.
let target: { hubAddr: string; cloud: boolean } | null = null;
const listeners: Record<string, () => void> = {};
const unlistened: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => (cmd === "get_lan_redirect_target_v3" ? target : null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: () => void) => {
    listeners[name] = cb;
    return () => {
      unlistened.push(name);
    };
  },
}));
vi.mock("../stores/sessionStore", () => ({ useSessionStore: { getState: () => ({ setExpired: () => {} }) } }));

import { LAN_CHANGE_EVENT, connectLanChangeSocket, invalidateLanTargetCache, isSatellite } from "./lan";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("a till joined over the internet", () => {
  beforeEach(() => {
    invalidateLanTargetCache();
    for (const k of Object.keys(listeners)) delete listeners[k];
    unlistened.length = 0;
  });

  it("counts as a satellite even with no LAN address", async () => {
    target = { hubAddr: "", cloud: true };
    expect(await isSatellite()).toBe(true);
  });

  it("standalone and hub terminals are not satellites", async () => {
    target = null;
    expect(await isSatellite()).toBe(false);
  });

  it("refreshes when the internet nudge event arrives, and stops listening on cleanup", async () => {
    target = { hubAddr: "", cloud: true };
    const onChange = vi.fn();
    const stop = connectLanChangeSocket(onChange);
    await tick();
    await tick();
    expect(listeners[LAN_CHANGE_EVENT]).toBeTypeOf("function");
    listeners[LAN_CHANGE_EVENT]();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    expect(unlistened).toContain(LAN_CHANGE_EVENT);
  });

  it("does not listen on a standalone terminal", async () => {
    target = null;
    const stop = connectLanChangeSocket(() => {});
    await tick();
    expect(listeners[LAN_CHANGE_EVENT]).toBeUndefined();
    stop();
  });
});
