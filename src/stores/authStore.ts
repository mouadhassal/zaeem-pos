import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "../lib/logger";
import type { UserRole } from "../db/types";

export interface AuthUser {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  photo_path?: string | null;
  restaurant_id: string;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  loginWithRust: (username: string, password: string) => Promise<string | null>;
  login: (user: AuthUser, token: string) => void;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  isLoading: true,

  loginWithRust: async (username: string, password: string) => {
    try {
      const deviceInfo = `${navigator.platform} | ${navigator.userAgent.slice(0, 50)}`;
      const response = await invoke("login", {
        request: { username, password },
        deviceInfo,
      }) as any;

      if (response.success && response.user && response.token) {
        localStorage.setItem("zaeem_auth_token", response.token);
        localStorage.setItem("zaeem_user", JSON.stringify(response.user));
        set({ user: response.user, token: response.token, isAuthenticated: true });
        return null;
      }
      return response.message || "فشل تسجيل الدخول";
    } catch (err) {
      logger.error("Login error", { error: String(err) });
      return "حدث خطأ في الاتصال بالنظام";
    }
  },

  login: (user: AuthUser, token: string) => {
    localStorage.setItem("zaeem_auth_token", token);
    localStorage.setItem("zaeem_user", JSON.stringify(user));
    set({ user, token, isAuthenticated: true });
  },

  logout: async () => {
    const { user } = get();
    if (user) {
      try { await invoke("logout", { userId: user.id }); } catch { /* ignore */ }
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
}));
