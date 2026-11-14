# Plan: workers without the app, per-worker permissions, one app shaped per business type

Status: steps 1-3 BUILT in 0.9.5 (2026-11-15) after the owner's review: the module table as
written, "workers" as an owner switch for managers (off by default), and the per-person list =
the 8 page areas + discount/special price, deleting a sent item, cancelling an order, gifts.
(Opening the drawer without a sale was left out: there is no such button and no server command
to guard.) Step 4 (new shop/supplier modules) is NOT built.

## 1. HR: workers who never touch the app

**Today:** every person in Staff is an app user with a role (Owner, Manager, Cashier, Kitchen).
Payroll, advances, attendance and the schedule only know these people. A cleaner, a guard, a
driver or a dishwasher can only be added by giving them a login role they should not have.

**Proposal:**
- Add a **job title** for everyone (free text with suggestions: عامل نظافة، حارس، سائق، شيف، معلّم،
  محاسب...). It shows in Staff, Payroll, the payslip and the schedule. The role stays the
  permission level; the job title is what the person *is*.
- Add a kind of person **"عامل بدون تطبيق"** (worker with no app access): no PIN, can never log in,
  appears in Payroll (salary, advances, deductions, bonuses), Attendance (manual punches or the
  fingerprint device) and the Schedule exactly like the others.
- Delivery drivers stay where they are (Delivery page) but can optionally be linked to a worker so
  their salary goes through Payroll too.

**Storage:** two new columns on `staff`: `job_title TEXT` and `app_access INTEGER DEFAULT 1`. A
no-app worker is stored with the lowest existing role (`SERVER`, which has no permissions today)
and `app_access = 0`; login refuses `app_access = 0` in Rust, so it cannot become a back door. No
change to the role CHECK constraint, so no table rebuild.

## 2. Permissions per worker, not only per role

**Today:** Settings > الصلاحيات sets what each *role* may do (reports, report print, finance,
inventory, menu, staff, refunds, settings), enforced in Rust (`role_access.rs`).

**Proposal:**
- Keep the role table as the default, and add **exceptions per person** on top: "Ahmad is a cashier
  but may do refunds", "Sara is a manager but may not see finance". Same screen, a second tab
  "حسب الموظف".
- Add the till actions owners keep asking about to the list: discounts, deleting a sent item,
  cancelling a whole order, changing a price, opening the drawer without a sale, gifts.
- Storage: `staff_access(staff_id, feature, allowed)`, only the differences, read in
  `security::authorize` right after the role table (the same single choke point, so every command
  is covered without per-command edits).

## 3. One app, shaped by the type of business

**Today:** one flag pair (`has_tables`, `has_kitchen`) and three presets (restaurant, shop,
supplier). Most screens are the restaurant's, with labels swapped for shops. Shops and suppliers
see restaurant leftovers and miss their own tools.

**Proposal: business type + modules.**
- The owner picks the **type** once (setup wizard, changeable in Settings): مطعم، مقهى، متجر/بقالة،
  مورّد/جملة. The type only chooses the **starting set of modules** and the words used.
- Every module can then be switched on or off by the owner (Settings > الوحدات), stored on the
  server side (`chain_config`), so all tills follow it. A module off = its pages, buttons and
  settings disappear; its Rust commands refuse (same pattern as POS Lite's `plan_gate.rs`).

| Module | Restaurant | Café | Shop | Supplier |
|---|---|---|---|---|
| Tables, split/merge | on | on | off | off |
| Kitchen slips + KDS, add-ons | on | on | off | off |
| Delivery + drivers | on | on | optional | on |
| Pickup queue | on | on | off | off |
| Barcode-first till, weighing | off | off | on | on |
| Debt book | optional | optional | on | on |
| Stockroom + suppliers | on | on | on | on |
| Marketplace link (sell to shops) | off | off | optional | on |
| Wholesale price lists, invoices with due dates | off | off | off | on |
| Barcode labels, sizes/colours, expiry dates | off | off | on | optional |
| Happy hour / combos | on | on | optional | off |

- Words follow the type: القائمة / المنتجات, طاولة / —, المطبخ / —, زبون / عميل تاجر.
- Till defaults follow the type (products per row, payment screen, pop-up add-ons...), still
  changeable per device in Preferences.

**Order of work (each step ships on its own):**
1. Modules switchboard + type in setup and Settings; existing pages mapped to modules (no new
   features, just hiding what does not belong).
2. Job title + no-app workers in Staff and Payroll.
3. Per-worker permission exceptions.
4. Missing shop/supplier modules one by one (barcode labels, sizes/colours, expiry, wholesale
   price lists, supplier invoices, branch transfer) — the list the owner explicitly kept out of
   0.9.0.

## Questions for the owner
1. Is the module table right for each type (especially café vs restaurant, and supplier)?
2. Should a manager be able to add no-app workers, or only the owner?
3. Which till actions must be on the per-worker list first?
