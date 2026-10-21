import { beforeEach, describe, expect, it, vi } from "vitest";

// `get_lan_redirect_target_v3` is how the frontend learns "am I a satellite?".
let hubTarget: { hubAddr: string } | null = null;
const tauriCalls: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    tauriCalls.push(cmd);
    if (cmd === "get_lan_redirect_target_v3") return hubTarget;
    if (cmd === "lan_relay_v3") return { redirected: false };
    return "local-ok";
  },
}));
vi.mock("../stores/sessionStore", () => ({ useSessionStore: { getState: () => ({ setExpired: () => {} }) } }));

import { invoke } from "./invoke";
import { HUB_ONLY_WRITE_ERROR, HUB_ONLY_WRITES, LAN_REDIRECT_COMMANDS, invalidateLanTargetCache } from "./lan";

describe("menu edits on a satellite", () => {
  beforeEach(() => {
    tauriCalls.length = 0;
    invalidateLanTargetCache();
  });

  it("refuses a menu write on a satellite instead of saving it to the unused local copy", async () => {
    hubTarget = { hubAddr: "192.168.1.10:7878" };
    await expect(invoke("update_menu_item_v3", { sessionToken: "t" })).rejects.toThrow(HUB_ONLY_WRITE_ERROR);
    expect(tauriCalls).not.toContain("update_menu_item_v3");
  });

  it("runs the same write locally on a hub or standalone terminal", async () => {
    hubTarget = null;
    await expect(invoke("update_menu_item_v3", { sessionToken: "t" })).resolves.toBe("local-ok");
    expect(tauriCalls).toContain("update_menu_item_v3");
  });

  it("never blocks a command the satellite forwards to the hub", () => {
    for (const cmd of HUB_ONLY_WRITES) expect(LAN_REDIRECT_COMMANDS.has(cmd), cmd).toBe(false);
  });
});
