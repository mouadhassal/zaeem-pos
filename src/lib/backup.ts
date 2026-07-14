import { logger } from "./logger";

const MAX_BACKUPS = 50;
const RETENTION_DAYS = 30;
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function getBackupKey(): string {
  return "zaeem_backups";
}

function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}-${h}${min}${s}`;
}

interface BackupRecord {
  id: string;
  timestamp: string;
  snapshot: string;
}

export async function createBackup(): Promise<string> {
  const timestamp = formatTimestamp(new Date());
  const id = `backup-${timestamp}`;

  try {
    const record: BackupRecord = {
      id,
      timestamp: new Date().toISOString(),
      snapshot: `snapshot-${timestamp}`,
    };

    const stored = localStorage.getItem(getBackupKey());
    const backups: BackupRecord[] = stored ? JSON.parse(stored) : [];
    backups.unshift(record);

    cleanupOldBackups(backups);
    localStorage.setItem(getBackupKey(), JSON.stringify(backups));

    logger.info("Backup created", { id, timestamp });
    return id;
  } catch (err) {
    logger.error("Backup failed", { error: String(err) });
    throw err;
  }
}

export async function createPreSyncSnapshot(): Promise<string> {
  return createBackup();
}

function cleanupOldBackups(backups: BackupRecord[]): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const filtered = backups.filter((b) => {
    const t = new Date(b.timestamp).getTime();
    return t > cutoff;
  });

  while (filtered.length > MAX_BACKUPS) {
    filtered.pop();
  }

  if (filtered.length !== backups.length) {
    localStorage.setItem(getBackupKey(), JSON.stringify(filtered));
  }
}

export function getBackups(): BackupRecord[] {
  try {
    const stored = localStorage.getItem(getBackupKey());
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

let backupTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoBackup(): void {
  if (backupTimer) return;
  logger.info("Auto-backup started", { intervalMs: BACKUP_INTERVAL_MS });
  createBackup();
  backupTimer = setInterval(createBackup, BACKUP_INTERVAL_MS);
}

export function stopAutoBackup(): void {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
}
