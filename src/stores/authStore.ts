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
}

function deviceInfo(): string {
  return `${navigator.platform} | ${navigator.userAgent.slice(0, 50)}`;
}

function toAuthUser(r: LoginV3Response): AuthUser {
  return {
    id: r.actor_id,
    name: r.name,
    username: r.name,
    role: r.role as UserRole,
    photo_path: null,
    restaurant_id: r.tenant_id,
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
    set({ user: null, token: null, isAuthenticated: false });
  },

  checkSession: async () => {
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
    try {
      const needs = await invoke<boolean>("needs_setup_v3");
      set({ needsSetup: needs, isLoading: false });
      if (!needs) {
        set({ isAuthenticated: false, user: null, token: null });
      }
    } catch {
      set({ needsSetup: false, isLoading: false });
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
