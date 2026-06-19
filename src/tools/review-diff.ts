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

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
import { logger } from "../logger.js";

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
  // ---- 1. Validate input ----
  const validation = validateInput("aux_review_diff", input);
  if (!validation.ok) {
    logger.warn("review-diff: input validation failed", {
      error: validation.error,
    });
    return {
      content: [
        {
          type: "text",
          text: `Input validation error: ${validation.error}`,
        },
      ],
      isError: true,
    };
  }

  const validated = validation.data as ReviewDiffInput;
  const { diff: originalDiff, focus } = validated;
  // max_chars is optional in the schema but Zod's .default() fills it at
  // parse time; the fallback matches the schema default (60_000).
  const maxChars: number = validated.max_chars ?? 60_000;

  // ---- 2. Truncate diff if longer than max_chars ----
  const inputTruncated = originalDiff.length > maxChars;
  const diff = inputTruncated ? originalDiff.slice(0, maxChars) : originalDiff;

  if (inputTruncated) {
    logger.warn("review-diff: diff truncated", {
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
      logger.warn(
        "review-diff: model path failed, falling back to heuristic",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      // Fall through to fallback path
    }
  } else {
    logger.info("review-diff: model not available, using heuristic fallback");
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
  logger.info("review-diff: attempting model review", {
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

  const outputValidation = validateOutput("aux_review_diff", parsed);
  if (!outputValidation.ok) {
    throw new Error(`Output schema validation failed: ${outputValidation.error}`);
  }

  const validatedOutput = outputValidation.data as ReviewDiffOutput;

  logger.info("review-diff: model review succeeded", {
    model: config.modelName,
  });

  // Override _meta with actual model info (the model may hallucinate its own _meta)
  const outputData: ReviewDiffOutput = {
    ...validatedOutput,
    _meta: {
      model: config.modelName,
      input_truncated: inputTruncated,
      fallback_used: false,
    },
  };

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
  logger.info("review-diff: using heuristic fallback");

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
}
