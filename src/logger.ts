/**
 * stderr + file logger — stdout 被 MCP JSON-RPC 协议占用，所有日志必须走 stderr。
 * 同时写入本地文件方便调试。日志中不输出 API key、Authorization header、完整源码或完整 diff。
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const LOG_LEVELS = ["off", "debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const MIN_LEVEL: LogLevel = (process.env.AUX_LOG_LEVEL as LogLevel) ?? "off";

/** 日志文件路径，第一次写日志时延迟解析（确保 .env 已加载）。 */
let LOG_FILE: string | null | undefined = undefined;

function resolveLogFilePath(): string | null {
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
    return null;
  }
}

function getLogFile(): string | null {
  if (LOG_FILE === undefined) {
    LOG_FILE = resolveLogFilePath();
  }
  return LOG_FILE;
}

function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

function writeToFile(text: string): void {
  const file = getLogFile();
  if (!file) return;
  try {
    appendFileSync(file, text + "\n", "utf-8");
  } catch {
    // 文件写入失败不阻塞 server
  }
}

function log(level: LogLevel, msg: string, data?: unknown): void {
  if (levelRank(level) < levelRank(MIN_LEVEL)) return;

  const ts = new Date().toISOString();
  const line = `[WINGMAN][${level.toUpperCase()}][${ts}] ${msg}`;
  process.stderr.write(line + "\n");
  writeToFile(line);

  if (data !== undefined) {
    const safe =
      typeof data === "string"
        ? data.slice(0, 500)
        : safeStringify(data).slice(0, 2000);
    const dataLine = `[WINGMAN][${level.toUpperCase()}] ${safe}`;
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
  return getLogFile();
}

// ---------------------------------------------------------------------------
// Trace meta helper — used by tool handlers to inject trace_id & tool_name
// into output _meta so callers can reference findings when submitting feedback
// ---------------------------------------------------------------------------

/**
 * Build the `trace_id` / `tool_name` fields for output `_meta`.
 * Handlers call this once at the top and spread the return into every `_meta`
 * they construct (model path, fallback path, and any error/minimal paths).
 */
export function createTraceMeta(traceId: string, toolName: string) {
  return { trace_id: traceId, tool_name: toolName };
}
