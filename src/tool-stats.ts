/**
 * 工具调用统计模块 — 按 tool name 聚合调用次数和 token 消耗，并持久化到本地 JSON。
 *
 * 安全约束：
 *   - 不记录 prompt、用户输入、diff、命令输出、文件内容或 API key。
 *   - 持久化使用临时文件 + rename 的原子替换策略。
 *   - 文件损坏时从空统计恢复，不阻断 server 启动或工具调用。
 *   - 统计数据仅供进程内观测，不得作为账单或审计依据。
 *
 * 并发安全：
 *   - 使用 AsyncLocalStorage 存储当前 tool 上下文，确保并发 tool call 的
 *     token 归属互不干扰。
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatResponseUsage } from "./chat-client.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolStatEntry {
  tool_name: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ToolStatsSnapshot {
  tools: ToolStatEntry[];
  generated_at: string;
  storage_scope: "local_file";
  stats_file: string;
}

/** On-disk persistence format — minimal, only aggregate counts and metadata. */
interface PersistedStats {
  schema_version: 1;
  updated_at: string;
  tools: Record<string, Omit<ToolStatEntry, "tool_name">>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Per-request tool context — 并发安全，每个异步调用链独立。 */
const toolContext = new AsyncLocalStorage<string>();

/** 进程内统计缓存：tool_name → 累计统计。 */
const stats = new Map<string, ToolStatEntry>();

/** 持久化文件路径（首次访问时解析）。 */
let statsFilePath: string | null | undefined = undefined;

/** 是否已从文件加载过统计。 */
let loaded = false;

// ---------------------------------------------------------------------------
// Tool context (replaces setCurrentTool / clearCurrentTool)
// ---------------------------------------------------------------------------

/**
 * 在 `name` 上下文中执行 `fn`。期间所有 `recordToolUsage()` 调用自动
 * 归属到该 tool。AsyncLocalStorage 保证并发请求互不干扰。
 */
export function runInToolContext<T>(name: string, fn: () => T): T {
  return toolContext.run(name, fn);
}

/** 返回当前异步上下文中的 tool name；无上下文时返回 undefined。 */
function getCurrentTool(): string | undefined {
  return toolContext.getStore();
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** 记录一次 tool 调用。幂等——同一个 tool 可多次调用。 */
export function recordToolCall(name: string): void {
  ensureLoaded();
  const entry = getOrCreate(name);
  entry.calls += 1;
}

/** 记录模型 usage 到当前异步上下文的 tool。无上下文时静默忽略。 */
export function recordToolUsage(usage: ChatResponseUsage): void {
  const toolName = getCurrentTool();
  if (!toolName) return;
  ensureLoaded();
  const entry = getOrCreate(toolName);
  entry.input_tokens += usage.prompt_tokens ?? 0;
  entry.output_tokens += usage.completion_tokens ?? 0;
  entry.total_tokens +=
    usage.total_tokens ??
    (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** 返回当前进程内统计快照。总是包含 `generated_at` 时间戳。 */
export function getToolStatsSnapshot(): ToolStatsSnapshot {
  ensureLoaded();
  const tools: ToolStatEntry[] = [];
  for (const [, entry] of stats) {
    tools.push({ ...entry });
  }
  // 按 tool_name 排序以保证输出稳定
  tools.sort((a, b) => a.tool_name.localeCompare(b.tool_name));

  return {
    tools,
    generated_at: new Date().toISOString(),
    storage_scope: "local_file",
    stats_file: resolveStatsFilePath(),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function resolveStatsFilePath(): string {
  if (statsFilePath !== undefined && statsFilePath !== null) return statsFilePath;

  const envPath = process.env.AUX_TOOL_STATS_FILE;
  if (envPath && envPath.length > 0) {
    statsFilePath = resolve(envPath);
  } else {
    statsFilePath = resolve(homedir(), ".wingman", "tool-stats.json");
  }
  return statsFilePath;
}

/** 确保目录存在，失败时静默返回 false。 */
function ensureStatsDir(filePath: string): boolean {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;

  const filePath = resolveStatsFilePath();
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    // 文件不存在是正常情况
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("tool-stats: persisted stats file is not valid JSON, starting from empty", {
      file: filePath,
    });
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    logger.warn("tool-stats: persisted stats file has unexpected shape, starting from empty", {
      file: filePath,
    });
    return;
  }

  const data = parsed as Record<string, unknown>;

  // Schema version check
  if (data.schema_version !== 1) {
    logger.warn("tool-stats: unknown schema_version, starting from empty", {
      file: filePath,
      schema_version: data.schema_version,
    });
    return;
  }

  const tools = data.tools;
  if (typeof tools !== "object" || tools === null) {
    logger.warn("tool-stats: persisted tools field missing or invalid, starting from empty", {
      file: filePath,
    });
    return;
  }

  // Load entries with validation
  let loadedCount = 0;
  for (const [name, entry] of Object.entries(tools as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.calls !== "number" ||
      typeof e.input_tokens !== "number" ||
      typeof e.output_tokens !== "number" ||
      typeof e.total_tokens !== "number"
    ) {
      continue;
    }
    stats.set(name, {
      tool_name: name,
      calls: Math.max(0, Math.floor(e.calls)),
      input_tokens: Math.max(0, Math.floor(e.input_tokens)),
      output_tokens: Math.max(0, Math.floor(e.output_tokens)),
      total_tokens: Math.max(0, Math.floor(e.total_tokens)),
    });
    loadedCount++;
  }

  if (loadedCount > 0) {
    logger.info("tool-stats: loaded persisted stats", { file: filePath, tools: loadedCount });
  }
}

/** 原子写入统计到持久化文件。失败时静默忽略——统计写入不影响工具调用。 */
export function flushToolStats(): void {
  const filePath = resolveStatsFilePath();

  if (!ensureStatsDir(filePath)) return;

  // 构建持久化格式
  const tools: Record<string, Omit<ToolStatEntry, "tool_name">> = {};
  for (const [, entry] of stats) {
    tools[entry.tool_name] = {
      calls: entry.calls,
      input_tokens: entry.input_tokens,
      output_tokens: entry.output_tokens,
      total_tokens: entry.total_tokens,
    };
  }

  const persisted: PersistedStats = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    tools,
  };

  // 原子写入：临时文件 → rename
  const tmpPath = filePath + "." + randomBytes(4).toString("hex") + ".tmp";
  try {
    writeFileSync(tmpPath, JSON.stringify(persisted), "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    // 清理临时文件
    try {
      unlinkSync(tmpPath);
    } catch {
      // 清理失败也忽略
    }
    logger.warn("tool-stats: failed to flush stats", {
      file: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getOrCreate(name: string): ToolStatEntry {
  const existing = stats.get(name);
  if (existing) return existing;
  const entry: ToolStatEntry = {
    tool_name: name,
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  stats.set(name, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Test helpers — 仅测试代码使用
// ---------------------------------------------------------------------------

/** 重置所有进程内状态和文件路径缓存。仅用于测试隔离。 */
export function resetToolStats(filePath?: string): void {
  stats.clear();
  loaded = false;
  if (filePath !== undefined) {
    statsFilePath = filePath;
  } else {
    statsFilePath = undefined;
  }
}
