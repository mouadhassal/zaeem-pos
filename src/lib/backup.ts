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

// 2026-09-13 audit fix: backup scheduling is now a real Tauri background
// timer (see backup.rs's `run_scheduled_backup_if_due`, started in
// `lib.rs::run`'s `setup` closure), not a `setInterval` tied to Settings
// being mounted. This settings row is what that background timer itself
// reads -- Settings just displays/edits it.
export interface BackupSettings {
  secondary_path: string | null;
  frequency_hours: number;
  last_auto_backup_at: string | null;
}

export async function getBackupSettings(token: string): Promise<BackupSettings> {
  return invoke<BackupSettings>("get_backup_settings_v3", { sessionToken: token });
}

export async function updateBackupSettings(token: string, secondaryPath: string | null, frequencyHours: number): Promise<void> {
  await invoke("update_backup_settings_v3", { sessionToken: token, secondaryPath, frequencyHours });
}
