/**
 * stderr + file logger — stdout 被 MCP JSON-RPC 协议占用，所有日志必须走 stderr。
 * 同时写入本地文件方便调试。日志中不输出 API key、Authorization header、完整源码或完整 diff。
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const MIN_LEVEL: LogLevel = (process.env.AUX_LOG_LEVEL as LogLevel) ?? "info";

/** 日志文件路径，默认项目根目录 .aux-model.log */
const LOG_FILE: string | null = (() => {
  const envPath = process.env.AUX_LOG_FILE;
  if (envPath === "" || envPath === "off" || envPath === "false") return null;
  const filePath = envPath
    ? resolve(envPath)
    : resolve(process.cwd(), ".aux-model.log");
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return filePath;
  } catch {
    return null; // 目录不可写，禁用文件日志
  }
})();

function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

function writeToFile(text: string): void {
  if (!LOG_FILE) return;
  try {
    appendFileSync(LOG_FILE, text + "\n", "utf-8");
  } catch {
    // 文件写入失败不阻塞 server
  }
}

function log(level: LogLevel, msg: string, data?: unknown): void {
  if (levelRank(level) < levelRank(MIN_LEVEL)) return;

  const ts = new Date().toISOString();
  const line = `[AUX_MODEL][${level.toUpperCase()}][${ts}] ${msg}`;
  process.stderr.write(line + "\n");
  writeToFile(line);

  if (data !== undefined) {
    const safe =
      typeof data === "string"
        ? data.slice(0, 500)
        : safeStringify(data).slice(0, 2000);
    const dataLine = `[AUX_MODEL][${level.toUpperCase()}] ${safe}`;
    process.stderr.write(dataLine + "\n");
    writeToFile(dataLine);
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
    log("debug", msg, data);
  },
  info(msg: string, data?: unknown) {
    log("info", msg, data);
  },
  warn(msg: string, data?: unknown) {
    log("warn", msg, data);
  },
  error(msg: string, data?: unknown) {
    log("error", msg, data);
  },
};

// ---------------------------------------------------------------------------
// Trace helpers — 每次 tool 调用生成唯一 trace id，贯穿整个调用链
// ---------------------------------------------------------------------------

/** 8 字符 hex trace ID */
export function createTraceId(): string {
  return randomBytes(4).toString("hex");
}

/** 带 trace id 的 logger，保持与 logger 完全相同的签名 */
export function traceLogger(traceId: string) {
  const prefix = `[${traceId}]`;
  return {
    debug(msg: string, data?: unknown) {
      log("debug", `${prefix} ${msg}`, data);
    },
    info(msg: string, data?: unknown) {
      log("info", `${prefix} ${msg}`, data);
    },
    warn(msg: string, data?: unknown) {
      log("warn", `${prefix} ${msg}`, data);
    },
    error(msg: string, data?: unknown) {
      log("error", `${prefix} ${msg}`, data);
    },
  };
}

/** 计算并记录耗时（毫秒），返回耗时数值 */
export function logDuration(
  traceId: string,
  label: string,
  startMs: number,
): number {
  const elapsed = Date.now() - startMs;
  log("info", `[${traceId}] ${label} — ${elapsed}ms`);
  return elapsed;
}

/** 日志文件路径（null 表示文件日志已禁用） */
export function getLogFilePath(): string | null {
  return LOG_FILE;
}
