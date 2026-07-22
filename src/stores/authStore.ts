import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "../lib/logger";
import type { UserRole } from "../db/types";

// Matches Rust's `commands_v3::LoginV3Response` -- `staff` has no `username`
// column and no `photo_path`, so those AuthUser fields from the old
// `users`-backed shape are gone; `restaurant_id` now holds `tenant_id`.
interface LoginV3Response {
  token: string;
  actor_id: string;
  name: string;
  role: string;
  tenant_id: string;
  branch_id: string | null;
}

export interface AuthUser {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  photo_path?: string | null;
  restaurant_id: string;
  /** null for Owner/Platform (tenant-scoped, no home branch) -- see open_shift_v3's doc comment. */
  branchId: string | null;
}

function deviceInfo(): string {
  return `${navigator.platform} | ${navigator.userAgent.slice(0, 50)}`;
}

// Browser-preview mode: when the app is run with `pnpm dev` in a plain browser
// (no Tauri runtime), every `invoke()` fails. To let the UI be inspected, we
// auto-authenticate as a demo owner so the full POS renders. This is gated to
// DEV and to the absence of the Tauri global, so it never runs in a real build.
const isBrowserPreview = import.meta.env.DEV && !("__TAURI__" in window);

function demoUser(): AuthUser {
  return {
    id: "demo-owner",
    name: "معاينة",
    username: "معاينة",
    role: "owner" as UserRole,
    photo_path: null,
    restaurant_id: "demo-tenant",
    branchId: null,
  };
}

function toAuthUser(r: LoginV3Response): AuthUser {
  return {
    id: r.actor_id,
    name: r.name,
    username: r.name,
    role: r.role as UserRole,
    photo_path: null,
    restaurant_id: r.tenant_id,
    branchId: r.branch_id,
  };
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  needsSetup: boolean;
  loginWithPin: (pin: string) => Promise<string | null>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  checkNeedsSetup: () => Promise<void>;
  setupOwner: (name: string, password: string, pin: string) => Promise<string | null>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<string | null>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  isLoading: true,
  needsSetup: false,

  loginWithPin: async (pin: string) => {
    try {
      const response = await invoke<LoginV3Response>("login_pin_v3", { pin, deviceId: deviceInfo() });
      const user = toAuthUser(response);
      localStorage.setItem("zaeem_auth_token", response.token);
      localStorage.setItem("zaeem_user", JSON.stringify(user));
      set({ user, token: response.token, isAuthenticated: true });
      return null;
    } catch (err) {
      logger.error("PIN login error", { error: String(err) });
      return typeof err === "string" ? err : "الرمز غير صحيح";
    }
  },

  logout: async () => {
    const { token } = get();
    if (token) {
      try { await invoke("logout_v3", { sessionToken: token }); } catch { /* ignore */ }
    }
    localStorage.removeItem("zaeem_auth_token");
    localStorage.removeItem("zaeem_user");
    // Clear all app state so the next user doesn't see stale data
    const { clearCart } = await import("./cartStore").then((m) => m.useCartStore.getState());
    const { resetOrderInfo } = await import("./orderTypeStore").then((m) => m.useOrderTypeStore.getState());
    clearCart();
    resetOrderInfo();
    set({ user: null, token: null, isAuthenticated: false });
  },

  checkSession: async () => {
    if (isBrowserPreview) {
      set({ user: demoUser(), token: "demo-token", isAuthenticated: true, isLoading: false });
      return;
    }
    const storedUser = localStorage.getItem("zaeem_user");
    const storedToken = localStorage.getItem("zaeem_auth_token");
    if (storedUser && storedToken) {
      try {
        const parsed = JSON.parse(storedUser);
        set({ user: parsed, token: storedToken, isAuthenticated: true, isLoading: false });
        return;
      } catch { /* corrupted data, clear */ }
      localStorage.removeItem("zaeem_auth_token");
      localStorage.removeItem("zaeem_user");
    }
    set({ isLoading: false });
  },

  checkNeedsSetup: async () => {
    if (isBrowserPreview) {
      set({ needsSetup: false, isLoading: false, isAuthenticated: true, user: demoUser(), token: "demo-token" });
      return;
    }
    try {
      const needs = await invoke<boolean>("needs_setup_v3");
      set({ needsSetup: needs, isLoading: false });
      if (!needs) {
        set({ isAuthenticated: false, user: null, token: null });
      }
    } catch {
      // If we can't reach the backend at all, keep loading state so the
      // user sees a spinner rather than being wrongly presented with the
      // login or setup screen.
      logger.error("needs_setup_v3 invoke failed", {});
      set({ isLoading: true });
    }
  },

  setupOwner: async (name: string, password: string, pin: string) => {
    try {
      const response = await invoke<LoginV3Response>("setup_owner_v3", { name, password, pin, deviceId: deviceInfo() });
      const user = toAuthUser(response);
      localStorage.setItem("zaeem_auth_token", response.token);
      localStorage.setItem("zaeem_user", JSON.stringify(user));
      set({ user, token: response.token, isAuthenticated: true, needsSetup: false });
      return null;
    } catch (err) {
      return typeof err === "string" ? err : "فشل إنشاء الحساب";
    }
  },

  changePassword: async (oldPassword: string, newPassword: string) => {
    const { token } = get();
    if (!token) return "لا توجد جلسة نشطة";
    try {
      await invoke("change_own_password_v3", {
        sessionToken: token,
        oldPassword,
        newPassword,
      });
      return null;
    } catch (err) {
      return typeof err === "string" ? err : "كلمة المرور القديمة غير صحيحة";
    }
  },
}));
