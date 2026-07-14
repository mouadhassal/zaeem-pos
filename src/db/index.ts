import Database from "@tauri-apps/plugin-sql";
import { Kysely } from "kysely";
import type { Database as ZaeemDatabase } from "./types";
import { TauriSqliteDialect } from "./tauri-dialect";
import { logger } from "../lib/logger";

let db: Kysely<ZaeemDatabase> | null = null;

export async function getDb(): Promise<Kysely<ZaeemDatabase>> {
  if (db) return db;

  const timer = logger.time("DB connection");
  const sqliteDb = await Database.load("sqlite:zaeem_pos.db");

  db = new Kysely<ZaeemDatabase>({
    dialect: new TauriSqliteDialect(sqliteDb),
  });

  timer.end({ module: "database" });
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
  }
}

export async function getDbStats(): Promise<{
  size: number;
  orderCount: number;
  pendingSync: number;
}> {
  try {
    const d = await getDb();
    const orderCount = (
      await d
        .selectFrom("orders")
        .select(d.fn.count<number>("id").as("count"))
        .executeTakeFirst()
    )?.count ?? 0;

    const pendingSync = (
      await d
        .selectFrom("sync_queue")
        .select(d.fn.count<number>("id").as("count"))
        .where("sync_status", "=", "pending")
        .executeTakeFirst()
    )?.count ?? 0;

    return { size: 0, orderCount, pendingSync };
  } catch {
    return { size: 0, orderCount: 0, pendingSync: 0 };
  }
}
