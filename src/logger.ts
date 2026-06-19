/**
 * stderr logger — stdout 被 MCP JSON-RPC 协议占用，所有日志必须走 stderr。
 * 日志中不输出 API key、Authorization header、完整源码或完整 diff。
 */

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const MIN_LEVEL: LogLevel = (process.env.AUX_LOG_LEVEL as LogLevel) ?? "info";

function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

function log(level: LogLevel, msg: string, data?: unknown): void {
  if (levelRank(level) < levelRank(MIN_LEVEL)) return;

  const ts = new Date().toISOString();
  const line = `[AUX_MODEL][${level.toUpperCase()}][${ts}] ${msg}`;
  process.stderr.write(line + "\n");

  if (data !== undefined) {
    // 浅层序列化，避免完整输出大对象
    const safe =
      typeof data === "string"
        ? data.slice(0, 500)
        : safeStringify(data).slice(0, 2000);
    process.stderr.write(
      `[AUX_MODEL][${level.toUpperCase()}] ${safe}\n`,
    );
  }
}

/** 过滤敏感 key 的浅层序列化 */
function safeStringify(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "string" && val.length > 400) return val.slice(0, 400) + "...";
      return val;
    });
  } catch {
    return "[unserializable]";
  }
}

export const logger = {
  debug(msg: string, data?: unknown) {
    log("debug" as LogLevel, msg, data);
  },
  info(msg: string, data?: unknown) {
    log("info" as LogLevel, msg, data);
  },
  warn(msg: string, data?: unknown) {
    log("warn" as LogLevel, msg, data);
  },
  error(msg: string, data?: unknown) {
    log("error" as LogLevel, msg, data);
  },
};
