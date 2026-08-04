# E2E (UI automation) tests

Drives the real, compiled app through WebView2's WebDriver interface --
real clicks, real Rust commands, real SQLite. Not a mocked DOM. This is
in addition to (not a replacement for) the Rust unit/integration tests in
`src-tauri/src` and the frontend `pnpm typecheck`.

## One-time machine setup

1. **`tauri-driver`** (proxies WebdriverIO -> WebView2's native driver):
   ```
   cargo install tauri-driver --locked
   ```
2. **`msedgedriver.exe`**, version-matched to the WebView2 Runtime actually
   installed on this machine (a mismatched version silently fails to
   connect -- this is the #1 way this class of setup breaks). Check your
   installed version:
   ```
   powershell -Command "(Get-Item 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application').GetDirectories() | Select-Object -First 1 Name"
   ```
   Then download the matching driver into `e2e/drivers/`:
   ```
   curl -L -o edgedriver.zip https://msedgedriver.microsoft.com/<VERSION>/edgedriver_win64.zip
   ```
   (unzip it, `msedgedriver.exe` should end up directly at `e2e/drivers/msedgedriver.exe`).
   Note: `msedgedriver.azureedge.net` (the domain most guides reference)
   is dead -- use `msedgedriver.microsoft.com`.
3. `pnpm install` inside this `e2e/` directory.

## Running

```
# from apps/zaeem-pos/ (one level up):
pnpm tauri build --debug --no-bundle   # (re)build app.exe with your latest changes

# from apps/zaeem-pos/e2e/:
pnpm test
```

The suite logs in via the dev-only quick-login button
(`data-testid="login-dev-quick-login"`, only rendered when
`import.meta.env.DEV` -- i.e. only in debug builds), which uses the
default staff account `seed_default_staff` seeds under
`#[cfg(debug_assertions)]` (see `src-tauri/src/lib.rs`). Never run this
against a release build or real customer data.

## Adding more tests

Add `data-testid` attributes to whatever you need to select in the
component you're testing -- don't rely on Arabic text content or CSS
classes as selectors, both change independent of behavior. Existing
hooks: `login-page`, `login-error`, `login-pin-digit-{0-9}`,
`login-pin-backspace`, `login-dev-quick-login`, `sidebar`,
`sidebar-nav-{id}` (id matches `SidebarNavItem.id` in
`src/lib/permissions.ts`, e.g. `sidebar-nav-pos`), `pos-page`.
