// Offline selling + resync, and the admin pause (suspension) seen from a
// real register. Runs against an already set-up, licensed register.
// node acceptance/resilience.mjs <register> [--steps=offline,pause]
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cloudEnv, startRegister } from "./harness.mjs";
import { OWNER_PIN } from "./owner.mjs";

const name = process.argv[2] ?? "A";
const only = (process.argv.find((a) => a.startsWith("--steps=")) ?? "").slice(8).split(",").filter(Boolean);
const sql = (q) => execFileSync("docker", ["exec", "supabase_db_wz-e2e", "psql", "-U", "postgres", "-tA", "-c", q], { encoding: "utf8" }).trim();
function lsql(q) {
  const db = path.join(process.env.APPDATA, `com.wenzdes.pos.e2e.${name.toLowerCase()}`, "zaeem_pos.db");
  const py = "import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;print(json.dumps([dict(r) for r in c.execute(sys.argv[2])],ensure_ascii=False))";
  return JSON.parse(execFileSync("python", ["-c", py, db, q], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf8" } }));
}
const results = [];
async function step(id, title, fn) {
  if (only.length && !only.includes(id)) return;
  try {
    await fn();
    results.push({ id, ok: true });
    console.log(`PASS ${id} ${title}`);
  } catch (e) {
    results.push({ id, ok: false, error: e.message });
    console.log(`FAIL ${id} ${title}\n  ${e.message}`);
  }
}

async function open(env) {
  const reg = await startRegister(name, { env });
  const b = reg.browser;
  await b.pause(4000);
  if (/⌫/.test(await reg.text())) for (const d of OWNER_PIN) await reg.click(new RegExp(`^${d}$`));
  await b.pause(2000);
  return { reg, b };
}

async function sellOne(reg, b) {
  await reg.click(/^الوردية$/);
  await b.pause(1200);
  if (/بدء الوردية/.test(await reg.text())) {
    await reg.type("input", "100000", 0);
    await reg.click(/^بدء الوردية$/);
    await b.pause(1500);
  }
  await reg.click(/^نقاط البيع$/);
  await b.pause(1000);
  await reg.click(/^سفري$/).catch(() => {});
  const item = lsql("select name, price_cents from menu_items where deleted_at is null order by price_cents limit 1")[0];
  await reg.addItem(item.name);
  await reg.click(/^دفع$/);
  await b.pause(1000);
  await reg.click(/^نقدي$/);
  await reg.type('input[placeholder="٠"]', String(item.price_cents), 0);
  await reg.click(/تأكيد وطباعة/);
  await b.pause(3000);
  const [last] = lsql("select id, status from orders order by created_at desc limit 1");
  if (last.status !== "PAID") throw new Error(`sale not completed (${last.status})`);
  return last.id;
}

const tenant = sql("select id from tenant where name='مطعم الشام'");

await step("offline", "no internet: the till still sells; the sale syncs once the connection is back", async () => {
  // A dead cloud address = the shop's internet is down.
  let { reg, b } = await open({ ZAEEM_SUPABASE_URL: "http://127.0.0.1:9", ZAEEM_SUPABASE_ANON_KEY: cloudEnv().ZAEEM_SUPABASE_ANON_KEY });
  let orderId;
  try {
    orderId = await sellOne(reg, b);
    await b.pause(35000); // at least one sync tick fails while offline
    const queued = lsql(`select count(*) n from sync_outbox where row_id = '${orderId}'`)[0].n;
    console.log(`  sold ${orderId} offline; queued for sync: ${queued}`);
    if (!queued) throw new Error("offline sale was not kept in the sync queue");
  } finally {
    await reg.stop();
  }
  ({ reg, b } = await open(cloudEnv()));
  try {
    for (let i = 0; i < 18; i++) {
      if (sql(`select count(*) from pos_order where pos_order_id = '${orderId}' and status = 'PAID'`) === "1") {
        console.log(`  synced after reconnect (~${(i + 1) * 5}s)`);
        return;
      }
      await b.pause(5000);
    }
    throw new Error("offline sale never reached the cloud after reconnecting");
  } finally {
    await reg.stop();
  }
});

await step("pause", "admin pauses the shop: back office locks, selling continues; unpause restores it", async () => {
  sql(`update tenant set is_suspended = true where id = '${tenant}'`);
  let { reg, b } = await open(cloudEnv());
  try {
    await b.pause(4000); // boot-time cloud check
    const t = await reg.text();
    const banner = (t.match(/[^\n]*(مقفلة|موقوف|معلق|الترخيص)[^\n]*/) ?? [""])[0];
    console.log("  paused banner:", banner);
    await reg.click(/^التقارير$/);
    await b.pause(1500);
    const locked = /مقفلة|مقفل/.test(await reg.text());
    console.log("  reports locked while paused:", locked);
    if (!locked) throw new Error("back office still open while the shop is paused");
    const id = await sellOne(reg, b);
    console.log("  sold while paused:", id);
  } finally {
    await reg.stop();
    sql(`update tenant set is_suspended = false where id = '${tenant}'`);
  }
  ({ reg, b } = await open(cloudEnv()));
  try {
    await b.pause(4000);
    await reg.click(/^التقارير$/);
    await b.pause(1500);
    if (/مقفلة/.test(await reg.text())) throw new Error("still locked after unpausing");
    console.log("  unpaused: back office open again");
  } finally {
    await reg.stop();
  }
});

console.log(JSON.stringify(results));
