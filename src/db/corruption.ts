import Database from "@tauri-apps/plugin-sql";

export interface IntegrityResult {
  ok: boolean;
  errors: string[];
}

export async function checkIntegrity(): Promise<IntegrityResult> {
  try {
    const db = await Database.load("sqlite:zaeem_pos.db");
    const result = await db.select<{ integrity_check: string }[]>(
      "PRAGMA integrity_check"
    );
    const errors = result
      .map((r) => r.integrity_check)
      .filter((line) => line !== "ok");

    return {
      ok: errors.length === 0,
      errors,
    };
  } catch (err) {
    return {
      ok: false,
      errors: [`Failed to run integrity check: ${err}`],
    };
  }
}

export async function applyPragmas(): Promise<void> {
  try {
    const db = await Database.load("sqlite:zaeem_pos.db");
    await db.execute("PRAGMA journal_mode = WAL");
    await db.execute("PRAGMA synchronous = NORMAL");
    await db.execute("PRAGMA foreign_keys = ON");
    await db.execute("PRAGMA busy_timeout = 5000");
  } catch {
    // pragmas are best-effort
  }
}

export async function getWalMode(): Promise<boolean> {
  try {
    const db = await Database.load("sqlite:zaeem_pos.db");
    const result = await db.select<{ journal_mode: string }[]>(
      "PRAGMA journal_mode"
    );
    return result[0]?.journal_mode === "wal";
  } catch {
    return false;
  }
}
