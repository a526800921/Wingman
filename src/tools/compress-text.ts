/**
 * aux_compress_text MCP tool handler.
 *
 * Orchestrates:
 *   1. Input schema validation
 *   2. Model-based compression (when API key is configured), with automatic
 *      fallback to heuristic compression on any failure.
 *   3. Output schema validation
 *   4. Structured CallToolResult
 */

import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { hasModelConfig, loadConfig, loadConfigFallback } from "../config.js";
import { ChatClient } from "../chat-client.js";
import { validateInput, validateOutput } from "../schema.js";
import {
  buildCompressTextSystemPrompt,
  buildCompressTextUserMessage,
  extractJsonFromResponse,
} from "../prompts.js";
import { compressTextFallback } from "../fallback/compress-text.js";
import { createTraceId, traceLogger, logDuration } from "../logger.js";

// ---------------------------------------------------------------------------
// Input shape (after validation)
// ---------------------------------------------------------------------------

interface CompressTextValidatedInput {
  text: string;
  label: string;
  focus?: string;
  max_chars?: number;
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export async function handleCompressText(
  input: unknown,
  config: ReturnType<typeof loadConfig> | ReturnType<typeof loadConfigFallback>,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const tid = createTraceId();
  const log = traceLogger(tid);

  // ---- 1. Validate input ----
  const inputResult = validateInput("aux_compress_text", input);
  if (!inputResult.ok) {
    throw new McpError(ErrorCode.InvalidParams, inputResult.error);
  }

  const data = inputResult.data as CompressTextValidatedInput;

  log.info("compress_text start", {
    label: data.label,
    focus: data.focus ?? undefined,
    textLen: data.text.length,
    max_chars: data.max_chars,
  });

  try {
    return await handleImpl();
  } finally {
    logDuration(tid, "compress_text done", t0);
  }

  async function handleImpl(): Promise<CallToolResult> {

  // ---- 2. Truncate text if longer than max_chars ----
  const maxChars = data.max_chars ?? 80_000;
  const originalLength = data.text.length;
  const inputTruncated = originalLength > maxChars;
  const text = inputTruncated ? data.text.slice(0, maxChars) : data.text;

  // ---- 3. Determine model availability ----
  // A full AppConfig has `modelApiKey`; the fallback config (Pick<AppConfig,
  // "workspaceRoot">) does not.
  const isFullConfig =
    "modelApiKey" in config && (config as AppConfig).modelApiKey.length > 0;

  const provider = isFullConfig
    ? (config as AppConfig).modelProvider
    : process.env.AUX_MODEL_PROVIDER ?? "remote";

  const modelAvailable = hasModelConfig() && isFullConfig;

  if (modelAvailable) {
    const result = await tryModelCompression(text, data, config as AppConfig, provider);
    if (result) {
      return result;
    }
  }

  // ---- 4. Fallback path ----
  return buildFallbackResult(text, data.label, maxChars, inputTruncated, provider);
}

// ---------------------------------------------------------------------------
// Model-based compression
// ---------------------------------------------------------------------------

async function tryModelCompression(
  text: string,
  data: CompressTextValidatedInput,
  appConfig: AppConfig,
  provider: string,
): Promise<CallToolResult | null> {
  const client = new ChatClient(appConfig);

  if (!client.isAvailable()) {
    log.info("compress-text: ChatClient not available, using fallback");
    return null;
  }

  log.info("compress-text: attempting model-based compression", {
    model: appConfig.modelName,
    label: data.label,
    textLen: text.length,
  });

  try {
    // Build prompts
    const systemPrompt = buildCompressTextSystemPrompt();
    const userMessage = buildCompressTextUserMessage(
      text,
      data.label,
      data.focus,
    );

    // Call model
    const response = await client.chat(systemPrompt, userMessage);

    // Extract JSON from the raw response (handles markdown fences, etc.)
    const jsonStr = extractJsonFromResponse(response);

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      log.warn(
        "compress-text: model response is not valid JSON, falling back to heuristic",
        {
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
          preview: jsonStr.slice(0, 200),
        },
      );
      return null;
    }

    // The model's output schema (from the system prompt) does NOT include
    // `_meta` — we must attach it ourselves before validation.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      log.warn(
        "compress-text: model response is not a JSON object, falling back",
      );
      return null;
    }

    (parsed as Record<string, unknown>).analysis_status = "complete";
    (parsed as Record<string, unknown>).is_authoritative = false;
    (parsed as Record<string, unknown>)._meta = {
      provider,
      model: appConfig.modelName,
      tokens_used: 0,
      input_truncated: text.length < data.text.length,
      fallback_used: false,
      analysis_status: "complete" as const,
      model_attempted: true,
    };

    // Validate the combined output against the full CompressTextOutput schema
    const outputResult = validateOutput("aux_compress_text", parsed);
    if (!outputResult.ok) {
      log.warn(
        "compress-text: model output failed schema validation, falling back",
        { error: outputResult.error },
      );
      return null;
    }

    log.info("compress-text: model-based compression succeeded", {
      model: appConfig.modelName,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(outputResult.data) }],
      isError: false,
    };
  } catch (err: unknown) {
    // Any exception (timeout, HTTP error, SSRF, network, etc.) triggers
    // fallback — the model path must never surface an error to the caller.
    log.warn("compress-text: model compression threw, using fallback", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fallback (heuristic) result
// ---------------------------------------------------------------------------

function buildFallbackResult(
  text: string,
  label: string,
  maxChars: number,
  inputTruncated: boolean,
  provider: string,
): CallToolResult {
  log.info("compress-text: using heuristic fallback compression", {
    label,
    textLen: text.length,
  });

  const fallbackResult = compressTextFallback(text, label, maxChars);

  // Assemble the full output: fallback payload + _meta
  const outputData = {
    ...fallbackResult,
    analysis_status: "partial" as const,
    _meta: {
      provider,
      model: "heuristic",
      tokens_used: 0,
      input_truncated: inputTruncated,
      fallback_used: true,
      analysis_status: "partial" as const,
      model_attempted: false,
      model_skip_reason: "model_not_configured",
    },
  };

  // Validate the assembled output for safety (should always pass since the
  // fallback is designed to match the schema).
  const outputResult = validateOutput("aux_compress_text", outputData);
  if (!outputResult.ok) {
    log.error(
      "compress-text: fallback output failed schema validation (unexpected)",
      { error: outputResult.error },
    );
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          outputResult.ok ? outputResult.data : outputData,
        ),
      },
    ],
    isError: false,
  };
  } // handleImpl
}
