import { invoke } from "./invoke";

// 2026-08-02: this used to write a fake `snapshot-<timestamp>` string into
// localStorage and call it a backup -- it never touched the real SQLite
// database, so every "تم إنشاء النسخة الاحتياطية بنجاح" message an owner
// saw was a lie. Now a thin wrapper over the real Rust command
// (backup_database_v3, see backup.rs), which runs `VACUUM INTO` against
// the actual database file.
export interface BackupInfo {
  path: string;
  size_bytes: number;
  created_at: string;
}

export async function createBackup(token: string): Promise<BackupInfo> {
  return invoke<BackupInfo>("backup_database_v3", { sessionToken: token });
}

export async function listBackups(token: string): Promise<BackupInfo[]> {
  return invoke<BackupInfo[]>("list_backups_v3", { sessionToken: token });
}
