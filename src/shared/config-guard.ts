/**
 * Shared config type guard — unified ConfigLike and hasApiKey.
 *
 * All 5 tool handlers use the same config discrimination logic. This module
 * eliminates the 4 different implementations (isFullConfig / hasApiKey /
 * inline checks) scattered across handler files.
 */

import { loadConfig, loadConfigFallback, hasModelConfig } from "../config.js";
import type { AppConfig } from "../config.js";

/** The config parameter passed to every tool handler. */
export type ConfigLike =
  | ReturnType<typeof loadConfig>
  | ReturnType<typeof loadConfigFallback>;

/** True when config is a full AppConfig with a usable API key. */
export function hasApiKey(config: ConfigLike): config is AppConfig {
  return (
    "modelApiKey" in config &&
    typeof (config as AppConfig).modelApiKey === "string" &&
    (config as AppConfig).modelApiKey.length > 0
  );
}

/** True when the model path is available (config loaded + API key present). */
export function isModelAvailable(config: ConfigLike): boolean {
  return hasModelConfig() && hasApiKey(config);
}
