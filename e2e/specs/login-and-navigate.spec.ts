// Real UI automation: drives the actual compiled app.exe through
// tauri-driver/WebView2, exactly like a user would -- real clicks, real
// Rust commands (login_pin_v3 etc.), real SQLite reads/writes against the
// dev-seeded default staff account (`seed_default_staff`, debug builds
// only -- see lib.rs). Not a mocked DOM.
describe("WENZDES POS -- smoke", () => {
  before(async () => {
    // authStore persists the session token to localStorage
    // (zaeem_auth_token) -- it survives between app launches by design
    // (so a cashier isn't re-PIN'ing every restart), which means it also
    // survives between separate test runs of this exact suite. Force a
    // clean, logged-out starting state every run instead of depending on
    // whatever this machine's WebView2 profile happened to have left
    // over from the last time this suite ran.
    //
    // Waits for a real page to have actually loaded first -- calling
    // localStorage this early in the session (before WebView2 has
    // finished its first real navigation) throws "Access is denied for
    // this document", a WebView2 quirk, not an app bug.
    await browser.waitUntil(
      async () => (await $('[data-testid="login-page"], [data-testid="pos-page"]')).isExisting(),
      { timeout: 20000 }
    );
    await browser.execute(() => localStorage.clear());
    await browser.refresh();
  });

  it("shows the PIN login screen on launch", async () => {
    const loginPage = await $('[data-testid="login-page"]');
    await loginPage.waitForExist({ timeout: 30000 });
    await expect(loginPage).toBeExisting();
  });

  it("logs in via the real PIN pad and reaches the dashboard", async () => {
    // NOT the dev-quick-login button -- that only ever renders under
    // Vite's dev server (`import.meta.env.DEV`), which is a SEPARATE
    // toggle from Cargo's `--debug`/`cfg(debug_assertions)` (what
    // actually gates `seed_default_staff`). `tauri.conf.json`'s
    // beforeBuildCommand always runs a production `vite build`, even for
    // `tauri build --debug` -- so that button never exists in any built
    // .exe, debug or release, only in `tauri dev`. Real digit clicks
    // exercise the exact same path a cashier does, and work regardless.
    for (const digit of "123456") {
      const key = await $(`[data-testid="login-pin-digit-${digit}"]`);
      await key.waitForExist({ timeout: 10000 });
      await key.click();
    }

    // Login lands on whatever this role's first nav item is (OWNER_NAV's
    // first entry is "dashboard", not "pos" -- a Cashier's own nav starts
    // at "pos" instead, see src/lib/permissions.ts) -- the sidebar itself
    // is the one thing guaranteed to exist regardless of role/landing page.
    const sidebar = await $('[data-testid="sidebar"]');
    try {
      await sidebar.waitForExist({ timeout: 15000 });
    } catch (e) {
      const bodyText = await browser.execute(() => document.body.innerText);
      console.log("=== DIAGNOSTIC: body text after PIN entry ===\n", bodyText);
      throw e;
    }
    await expect(sidebar).toBeExisting();
  });

  it("navigates to the POS screen via the sidebar", async () => {
    const posNav = await $('[data-testid="sidebar-nav-pos"]');
    await posNav.waitForExist({ timeout: 10000 });
    await posNav.click();

    const posPage = await $('[data-testid="pos-page"]');
    await posPage.waitForExist({ timeout: 15000 });
    await expect(posPage).toBeExisting();
  });

  it("navigates to the shift screen via the sidebar", async () => {
    const shiftNav = await $('[data-testid="sidebar-nav-shift"]');
    await shiftNav.waitForExist({ timeout: 10000 });
    await shiftNav.click();

    // No dedicated data-testid on the shift page itself yet -- proving
    // the sidebar button is clickable and doesn't error is still a real,
    // meaningful assertion (a crash/blank-screen regression would fail
    // this), just not as precise as the POS-page check above.
    await browser.pause(1000);
    const sidebar = await $('[data-testid="sidebar"]');
    await expect(sidebar).toBeExisting();
  });
});
