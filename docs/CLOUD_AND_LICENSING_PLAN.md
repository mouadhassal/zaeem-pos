# CLOUD_AND_LICENSING_PLAN.md — Discussion & Design (not a build order yet)

Purpose: answer "how does licensing work," design the cloud, and define the admin tool
as slice 1 of the eventual owner dashboard — so nothing built now gets thrown away.

Key decision driving this doc: **owners will self-serve eventually.** Therefore the
admin tool and the owner dashboard are ONE web app with role levels, not two apps.

---

## 1. The three systems (do not conflate them)

| System | Who uses it | Needs cloud? | Cost | When |
|---|---|---|---|---|
| **A. Admin/license console** | You (Platform) now; resellers + owners later | Yes (shared DB) | Small first slice | Build now |
| **B. Owner remote dashboard** | Restaurant owner, from phone | Yes | Weeks (full S6) | After restaurant #1–5 |
| **C. Cloud sync** | The POS devices, automatically | Yes | Weeks | With B |

A and B are the **same web app**, different roles. C is the plumbing that feeds B.
Build A's first slice now; A grows into B; C is built when B needs live data.

---

## 2. How licensing works, end to end (already built, minus the nice UI)

The cryptography and enforcement are DONE (Ed25519, machine-bound, offline, grace
period, renewal, all tested). What's missing is only the human-friendly way to mint.

**Today (works, but via CLI):**
1. Restaurant pays the reseller (cash, in Syria).
2. You run `license_signer mint --tenant X --branch Y --months 12`.
3. It signs a blob with your private key (kept offline).
4. Blob → restaurant via QR / file / WhatsApp.
5. Their app verifies against the public key compiled into the binary, bound to their
   machine. Offline-valid until expiry. Renews the same way.

**The only gap:** step 2 is a command line. The admin console replaces it with a form.

**Critical secret:** the private signing key. It signs every license. If it leaks,
anyone mints free licenses. It must live offline (password manager / hardware), NEVER
in the repo, the app, or the cloud. The admin console calls a signing step that holds
the key server-side or on your machine — never ships it to a browser.

---

## 3. The cloud design (Supabase, EU/Frankfurt)

Why Supabase: Postgres Row-Level Security enforces tenant/branch scoping AT the
database (second wall behind your Rust scope checks), built-in auth for the web app,
EU hosting (matches you, sidesteps US↔Syria data questions), free tier to validate.

**Tables (mirror your local schema — every row already has tenant_id/branch_id):**
```
tenant        (id, name, is_demo, created_at)
branch        (id, tenant_id, name, currency, locale, ...)
license       (id, tenant_id, branch_id, machine_fp, plan, features,
               issued_at, expires_at, status, nonce)     ← the mint log
app_user      (id, tenant_id?, role, email, ...)         ← platform/owner/manager logins
sales_fact    (id, tenant_id, branch_id, ... )           ← ingested from POS (system C)
```

**RLS is the whole trick:** a Postgres policy like "a user may only read rows where
tenant_id = their tenant" means even a bug in the web app can't leak one restaurant's
data to another. Same guarantee your Rust scope layer gives locally, enforced again in
the cloud.

**What the cloud is NOT:** it is not the POS's database. The POS runs on local SQLite,
offline. The cloud aggregates and serves the dashboard. Never move POS reads/writes to
the cloud — that destroys the offline moat.

---

## 4. The web app, in slices (A grows into B)

Same Next.js/React app on Supabase, roles gate the screens.

**Slice 1 — Platform admin (build first, this is "the admin tool"):**
- Your login (Platform role).
- Create tenant · create branch · set currency/locale.
- Mint a license → calls the signing step → returns QR + blob.
- Renew a license (same).
- Table of all tenants/branches/licenses with expiry status.
- No sync, no sales data yet — just tenant/branch/license management.

**Slice 2 — Owner read-only dashboard (later, needs system C):**
- Owner login (Tenant role, RLS-scoped).
- Yesterday's revenue, top items, staff hours, low stock — per branch + roll-up.
- Read-only. Fed by ingested sales facts.

**Slice 3 — Owner self-serve + manager (later):**
- Owner adds staff, sets tenant-default menu/prices, adjusts caps.
- Reseller role: can mint licenses for tenants they onboard.

Slice 1 is genuinely useful now (professional onboarding, no CLI). Slices 2–3 wait
until an owner actually needs remote visibility.

---

## 5. System C — sync (built when Slice 2 needs it)

Already designed in your local schema: every row has `tenant_id`, `branch_id`, and the
sync columns (`updated_at_hlc`, `device_id`, `deleted_at`, `rev`); money is append-only
facts. Sync = the POS pushes new facts to Supabase when online, pulls config changes
down. Append-only money means no merge conflicts. The branch device is the source of
truth; the cloud aggregates. This is the deferred S5′/S6 work.

---

## 6. Recommended sequencing (given: one offline restaurant now)

1. **Now:** Slice 1 admin console (local-first is fine — even without Supabase, a small
   local web form that wraps the signing CLI removes the command line). Decide: local
   form now, or start it on Supabase so it's the real thing from day one?
2. **Restaurant #1 lives** on the offline POS. Collect cash, mint licenses via Slice 1.
3. **When an owner asks to see numbers remotely** (or at branch #2): build system C
   (sync) + Slice 2 (dashboard) on Supabase.
4. **When you have resellers/multiple owners:** Slice 3 self-serve.

Don't build 3–4 before the demand is real. Do build 1 now — it's small and it makes
onboarding a customer feel like a real company.

---

## 7. Open questions for us to decide before building Slice 1

- **Slice 1 hosting:** a quick LOCAL web form (fastest, no cloud, but only you can use
  it from your machine), OR start it on Supabase now (more setup, but it's the real
  multi-user thing owners/resellers eventually log into)? Given "owners self-serve
  eventually," leaning Supabase-from-the-start so it grows instead of getting rebuilt.
- **Where the signing key lives** once it's a web app: on a tiny signing service you
  control (key never in browser), or you keep minting locally and the web app just
  records/manages? The second is safer and simpler to start.
- **Production keypair:** must be generated fresh before shipping (the current one is a
  burned dev key). This is a ship-checklist item regardless.
