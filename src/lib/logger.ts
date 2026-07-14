type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  msg: string;
  timestamp: string;
  module?: string;
  durationMs?: number;
  error?: string;
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel =
  (typeof window !== "undefined" &&
    (import.meta.env.VITE_LOG_LEVEL as LogLevel)) ||
  "info";

function writeLog(entry: LogEntry): void {
  if (LOG_LEVELS[entry.level] < LOG_LEVELS[currentLevel]) return;

  const line = JSON.stringify(entry);

  switch (entry.level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "debug":
      console.debug(line);
      break;
    default:
      console.log(line);
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) =>
    writeLog({
      level: "debug",
      msg,
      timestamp: new Date().toISOString(),
      ...meta,
    }),

  info: (msg: string, meta?: Record<string, unknown>) =>
    writeLog({
      level: "info",
      msg,
      timestamp: new Date().toISOString(),
      ...meta,
    }),

  warn: (msg: string, meta?: Record<string, unknown>) =>
    writeLog({
      level: "warn",
      msg,
      timestamp: new Date().toISOString(),
      ...meta,
    }),

  error: (msg: string, meta?: Record<string, unknown>) =>
    writeLog({
      level: "error",
      msg,
      timestamp: new Date().toISOString(),
      ...meta,
    }),

  time: (label: string) => {
    const start = performance.now();
    return {
      end: (meta?: Record<string, unknown>) => {
        const duration = performance.now() - start;
        writeLog({
          level: "info",
          msg: label,
          timestamp: new Date().toISOString(),
          durationMs: Math.round(duration),
          ...meta,
        });
        return duration;
      },
    };
  },
};
