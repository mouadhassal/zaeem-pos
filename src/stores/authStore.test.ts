import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore, type AuthUser } from "./authStore";
import { invoke } from "../lib/invoke";

// checkSession's whole point is that the frontend must NOT trust the
// localStorage blob -- the Rust layer is the only authority on whether a
// session is live. Mock the invoke transport so these tests exercise the
// authStore decision logic in isolation.
vi.mock("../lib/invoke", () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

const validUser: AuthUser = {
  id: "actor-1",
  name: "Test Cashier",
  username: "Test Cashier",
  role: "CASHIER",
  photo_path: null,
  restaurant_id: "tenant-1",
  branchId: null,
};

function seedStoredSession() {
  localStorage.setItem("zaeem_auth_token", "live-token");
  localStorage.setItem("zaeem_user", JSON.stringify(validUser));
}

describe("authStore.checkSession", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false, isLoading: true, needsSetup: false });
  });

  it("verifies the stored token against the Rust layer before restoring the session", async () => {
    seedStoredSession();
    mockInvoke.mockResolvedValueOnce([]);

    await useAuthStore.getState().checkSession();

    // The canary is a real session-authenticated command -- the token MUST
    // be passed through it, or the check proves nothing.
    expect(mockInvoke).toHaveBeenCalledWith("list_categories_v3", { sessionToken: "live-token" });
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.token).toBe("live-token");
    expect(s.user).toEqual(validUser);
  });

  it("clears the session when the stored token is rejected (forged/stale)", async () => {
    seedStoredSession();
    mockInvoke.mockRejectedValueOnce("session expired");

    await useAuthStore.getState().checkSession();

    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.token).toBeNull();
    expect(s.user).toBeNull();
    expect(localStorage.getItem("zaeem_auth_token")).toBeNull();
    expect(localStorage.getItem("zaeem_user")).toBeNull();
  });

  it("clears without calling the backend when the stored user is corrupted", async () => {
    localStorage.setItem("zaeem_auth_token", "some-token");
    localStorage.setItem("zaeem_user", "{not json");

    await useAuthStore.getState().checkSession();

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem("zaeem_auth_token")).toBeNull();
  });

  it("stays logged out without calling the backend when no session was stored", async () => {
    await useAuthStore.getState().checkSession();

    expect(mockInvoke).not.toHaveBeenCalled();
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.isLoading).toBe(false);
  });
});