/**
 * aux_review_diff tool handler.
 *
 * Orchestrates diff review:
 *   1. Validate input via schema
 *   2. Try model-based diff review (if model available), fallback to heuristic on any failure
 *   3. Validate output via schema
 *   4. Return structured CallToolResult
 *
 * Error classification:
 *   - Input schema invalid → isError: true
 *   - Model API unavailable/fails/non-JSON/schema invalid → normal result with fallback
 */

import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { hasModelConfig, loadConfig, loadConfigFallback } from "../config.js";
import { ChatClient } from "../chat-client.js";
import {
  validateInput,
  validateOutput,
  type ReviewDiffInput,
  type ReviewDiffOutput,
} from "../schema.js";
import {
  buildReviewDiffSystemPrompt,
  buildReviewDiffUserMessage,
  extractJsonFromResponse,
} from "../prompts.js";
import { reviewDiffFallback } from "../fallback/review-diff.js";
import { createTraceId, traceLogger, logDuration } from "../logger.js";

// ---------------------------------------------------------------------------
// Config discrimination
// ---------------------------------------------------------------------------

/** The config parameter may be full AppConfig or fallback config. */
type ConfigLike = ReturnType<typeof loadConfig> | ReturnType<typeof loadConfigFallback>;

/**
 * Check whether config has a usable modelApiKey (i.e. it is a full AppConfig
 * with a non-empty key).  Used together with hasModelConfig() to determine
 * whether the model path is available.
 */
function hasApiKey(config: ConfigLike): config is AppConfig {
  return (
    "modelApiKey" in config &&
    typeof (config as AppConfig).modelApiKey === "string" &&
    (config as AppConfig).modelApiKey.length > 0
  );
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleReviewDiff(
  input: unknown,
  config: ConfigLike,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const tid = createTraceId();
  const log = traceLogger(tid);

  // ---- 1. Validate input ----
  const validation = validateInput("aux_review_diff", input);
  if (!validation.ok) {
    throw new McpError(ErrorCode.InvalidParams, validation.error);
  }

  const validated = validation.data as ReviewDiffInput;
  const { diff: originalDiff, focus } = validated;
  const maxChars: number = validated.max_chars ?? 60_000;

  log.info("review_diff start", {
    diffLen: originalDiff.length,
    focus: focus ?? undefined,
    max_chars: maxChars,
  });

  try {
    return await handleImpl();
  } finally {
    logDuration(tid, "review_diff done", t0);
  }

  async function handleImpl(): Promise<CallToolResult> {

  // ---- 2. Truncate diff if longer than max_chars ----
  const inputTruncated = originalDiff.length > maxChars;
  const diff = inputTruncated ? originalDiff.slice(0, maxChars) : originalDiff;

  if (inputTruncated) {
    log.warn("review-diff: diff truncated", {
      originalLength: originalDiff.length,
      maxChars,
    });
  }

  // ---- 3. Determine if model is available ----
  const modelAvailable = hasModelConfig() && hasApiKey(config);

  if (modelAvailable) {
    try {
      return await modelReview(config, diff, focus, inputTruncated);
    } catch (err: unknown) {
      log.warn(
        "review-diff: model path failed, falling back to heuristic",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      // Fall through to fallback path
    }
  } else {
    log.info("review-diff: model not available, using heuristic fallback");
  }

  // ---- 4. Heuristic fallback path ----
  return heuristicReview(diff, maxChars, inputTruncated);
}

// ---------------------------------------------------------------------------
// Model review path
// ---------------------------------------------------------------------------

async function modelReview(
  config: AppConfig,
  diff: string,
  focus: string | undefined,
  inputTruncated: boolean,
): Promise<CallToolResult> {
  log.info("review-diff: attempting model review", {
    model: config.modelName,
  });

  const client = new ChatClient(config);

  if (!client.isAvailable()) {
    throw new Error("ChatClient reported unavailable despite modelApiKey being set");
  }

  const systemPrompt = buildReviewDiffSystemPrompt();
  const userMessage = buildReviewDiffUserMessage(diff, focus);

  const rawResponse = await client.chat(systemPrompt, userMessage);

  const jsonStr = extractJsonFromResponse(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("Model response is not valid JSON");
  }

  // Attach _meta before schema validation (model prompt does not include _meta)
  const outputWithMeta = {
    ...(parsed as Record<string, unknown>),
    _meta: {
      model: config.modelName,
      input_truncated: inputTruncated,
      fallback_used: false,
    },
  };

  const outputValidation = validateOutput("aux_review_diff", outputWithMeta);
  if (!outputValidation.ok) {
    throw new Error(`Output schema validation failed: ${outputValidation.error}`);
  }

  const outputData = outputValidation.data as ReviewDiffOutput;

  log.info("review-diff: model review succeeded", {
    model: config.modelName,
  });

  return {
    content: [{ type: "text", text: JSON.stringify(outputData) }],
    isError: false,
  };
}

// ---------------------------------------------------------------------------
// Heuristic fallback path
// ---------------------------------------------------------------------------

function heuristicReview(
  diff: string,
  maxChars: number,
  inputTruncated: boolean,
): CallToolResult {
  log.info("review-diff: using heuristic fallback");

  const fallbackResult = reviewDiffFallback(diff, maxChars);

  const outputData = {
    ...fallbackResult,
    _meta: {
      model: "heuristic",
      tokens_used: 0,
      input_truncated: inputTruncated,
      fallback_used: true,
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(outputData) }],
    isError: false,
  };
  } // handleImpl
}
