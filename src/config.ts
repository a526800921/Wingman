/**
 * 配置读取 — 默认只从进程环境变量读取。
 * API key 永不写入 .mcp.json。
 * 如需本地 env 文件，显式设置 AUX_ENV_FILE=/absolute/path/to/.env。
 */

import { readFileSync } from "node:fs";
import { logger } from "./logger.js";

/** 显式指定时才从 env 文件加载，避免 npm 包意外读取调用方项目配置。 */
function loadDotEnv(): void {
  const envPath = process.env.AUX_ENV_FILE;
  if (!envPath) return;

  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      // 不覆盖已有环境变量（shell 优先级更高）
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
    logger.debug("env file loaded", { envPath });
  } catch (err) {
    logger.warn("env file load failed", {
      envPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

loadDotEnv();

export interface AppConfig {
  modelBaseUrl: string;
  modelApiKey: string;
  modelName: string;
  modelProvider: string; // "remote" | "local", from AUX_MODEL_PROVIDER
  modelTimeoutMs: number;
  modelAllowedHosts: string[];
  modelDisableThinking: boolean;
  allowInsecureLocalHttp: boolean;
  workspaceRoot: string;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT = 30_000;

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        `Set it in the process environment or via AUX_ENV_FILE. ` +
        `Do NOT store API keys in .mcp.json.`,
    );
  }
  return val;
}

export function loadConfig(): AppConfig {
  const modelBaseUrl = process.env.AUX_MODEL_BASE_URL || DEFAULT_BASE_URL;
  const modelApiKey = requireEnv("AUX_MODEL_API_KEY");
  const modelName = process.env.AUX_MODEL_NAME || DEFAULT_MODEL;
  const modelProvider = process.env.AUX_MODEL_PROVIDER || "remote";
  const modelTimeoutMs = Number(process.env.AUX_MODEL_TIMEOUT_MS) || DEFAULT_TIMEOUT;
  const modelAllowedHosts = process.env.AUX_MODEL_ALLOWED_HOSTS
    ? process.env.AUX_MODEL_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
    : [];
  const modelDisableThinking =
    process.env.AUX_MODEL_DISABLE_THINKING === "true";
  const allowInsecureLocalHttp =
    process.env.AUX_ALLOW_INSECURE_LOCAL_HTTP === "true";
  const workspaceRoot =
    process.env.AUX_WORKSPACE_ROOT || process.cwd();

  logger.info("config loaded", {
    modelBaseUrl: modelBaseUrl.replace(/\/\/.*@/, "//***@"),
    modelName,
    modelProvider,
    modelTimeoutMs,
    modelAllowedHosts,
    modelDisableThinking,
    allowInsecureLocalHttp,
    workspaceRoot,
    hasApiKey: !!modelApiKey,
  });

  return {
    modelBaseUrl,
    modelApiKey,
    modelName,
    modelProvider,
    modelTimeoutMs,
    modelAllowedHosts,
    modelDisableThinking,
    allowInsecureLocalHttp,
    workspaceRoot,
  };
}

/** 无 API key 时的最小配置（仅 fallback 模式可用） */
export function loadConfigFallback(): Pick<
  AppConfig,
  "workspaceRoot"
> {
  return {
    workspaceRoot: process.env.AUX_WORKSPACE_ROOT || process.cwd(),
  };
}

export function hasModelConfig(): boolean {
  return !!process.env.AUX_MODEL_API_KEY;
}
