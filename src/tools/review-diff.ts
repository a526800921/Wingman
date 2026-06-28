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
import { buildDiagnosticMeta } from "../model-runtime/diagnostics.js";
import { createTraceId, createTraceMeta, traceLogger, logDuration } from "../logger.js";

// ---------------------------------------------------------------------------
// Smart diff truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a unified diff intelligently: keep all file headers (---/+++ lines),
 * distribute remaining chars proportionally across files, and truncate at hunk
 * boundaries when a file section exceeds its allocation.
 */
function smartTruncateDiff(
  diff: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (diff.length <= maxChars) {
    return { text: diff, truncated: false };
  }

  // Split diff into per-file sections using ---/+++ header pairs
  const fileHeaderRe = /^(---\s+\S+.*\n\+\+\+\s+\S+.*\n)/gm;
  const sections: { header: string; body: string }[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = fileHeaderRe.exec(diff)) !== null) {
    // Capture any preamble before the first file header
    if (lastIdx < match.index) {
      sections.push({
        header: "",
        body: diff.slice(lastIdx, match.index),
      });
    }
    const bodyStart = match.index + match[0].length;
    fileHeaderRe.lastIndex = bodyStart;
    const nextMatch = fileHeaderRe.exec(diff);
    const bodyEnd = nextMatch ? nextMatch.index : diff.length;
    sections.push({
      header: match[0],
      body: diff.slice(bodyStart, bodyEnd),
    });
    lastIdx = bodyEnd;
    if (nextMatch) {
      fileHeaderRe.lastIndex = nextMatch.index;
    }
  }

  // If we didn't find at least one file header, fall back to simple truncation
  if (sections.length === 0) {
    return { text: diff.slice(0, maxChars), truncated: true };
  }

  // Calculate total header size
  const totalHeaderSize = sections.reduce((sum, s) => sum + s.header.length, 0);

  // If headers alone exceed maxChars, fall back to simple truncation
  if (totalHeaderSize >= maxChars) {
    return { text: diff.slice(0, maxChars), truncated: true };
  }

  // Distribute remaining chars across files proportionally to their body sizes
  const remainingChars = maxChars - totalHeaderSize;
  const totalBodySize = sections.reduce((sum, s) => sum + s.body.length, 0);

  let result = "";
  let truncated = false;

  for (const section of sections) {
    result += section.header;
    if (section.body.length === 0) continue;

    // Allocate proportionally, minimum 200 chars per file body
    const proportion =
      totalBodySize > 0 ? section.body.length / totalBodySize : 0;
    const allocation = Math.max(
      Math.floor(remainingChars * proportion),
      200,
    );

    if (section.body.length <= allocation) {
      result += section.body;
    } else {
      // Truncate at the last complete hunk boundary that fits
      result += truncateBodyAtHunk(section.body, allocation);
      truncated = true;
    }
  }

  return { text: result, truncated };
}

/**
 * Truncate a diff body at the last complete hunk boundary that fits within
 * the given character limit.
 */
function truncateBodyAtHunk(body: string, maxLen: number): string {
  if (body.length <= maxLen) return body;

  const hunkRe = /^@@\s+-(\d+),?(\d*)\s+\+(\d+),?(\d*)\s+@@.*\n/gm;
  let lastHunkEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = hunkRe.exec(body)) !== null) {
    const hunkStart = match.index;
    if (hunkStart >= maxLen) break;

    // Find end of this hunk (start of next, or end of body)
    const nextIdx = hunkRe.exec(body);
    const hunkEnd = nextIdx ? nextIdx.index : body.length;

    if (hunkEnd <= maxLen) {
      lastHunkEnd = hunkEnd;
    } else {
      break;
    }

    if (nextIdx) {
      hunkRe.lastIndex = nextIdx.index;
    } else {
      break;
    }
  }

  if (lastHunkEnd > 0) {
    return (
      body.slice(0, lastHunkEnd) +
      "\n@@ ... (truncated, remaining hunks omitted) @@\n"
    );
  }

  // Fallback: simple slice at maxLen
  return body.slice(0, maxLen) + "\n... (truncated)\n";
}

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
  const traceMeta = createTraceMeta(tid, "aux_review_diff");
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

  // ---- 2. Smart truncate diff if longer than max_chars ----
  const truncation = smartTruncateDiff(originalDiff, maxChars);
  const diff = truncation.text;
  const inputTruncated = truncation.truncated;

  if (inputTruncated) {
    log.warn("review-diff: diff truncated", {
      originalLength: originalDiff.length,
      truncatedLength: diff.length,
      maxChars,
    });
  }

  // ---- 3. Determine provider for _meta ----
  const provider = (config as AppConfig).modelProvider ??
    process.env.AUX_MODEL_PROVIDER ??
    "remote";

  // ---- 4. Determine if model is available ----
  const modelAvailable = hasModelConfig() && hasApiKey(config);

  if (modelAvailable) {
    try {
      return await modelReview(config, diff, focus, inputTruncated, provider, traceMeta);
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

  // ---- 5. Heuristic fallback path ----
  return heuristicReview(diff, maxChars, inputTruncated, provider, traceMeta);
}

// ---------------------------------------------------------------------------
// Model review path
// ---------------------------------------------------------------------------

async function modelReview(
  config: AppConfig,
  diff: string,
  focus: string | undefined,
  inputTruncated: boolean,
  provider: string,
  traceMeta: ReturnType<typeof createTraceMeta>,
): Promise<CallToolResult> {
  log.info("review-diff: attempting model review", {
    model: config.modelName,
  });

  const client = new ChatClient(config);

  if (!client.isAvailable()) {
    throw new Error("ChatClient reported unavailable despite modelApiKey being set");
  }

  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildReviewDiffSystemPrompt(today);
  const userMessage = buildReviewDiffUserMessage(diff, focus, today);

  const { text: rawResponse, usage } = await client.chat(systemPrompt, userMessage);

  const jsonStr = extractJsonFromResponse(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("Model response is not valid JSON");
  }

  // P2: collect heuristic signals from fallback for comparison
  const heuristicSignals = reviewDiffFallback(diff, maxChars).possible_risks.map(r => ({
    kind: r.risk,
    location: r.location,
    evidence: r.evidence ?? "",
    confidence: (r.confidence === "high" ? "medium" : r.confidence ?? "low") as "low" | "medium",
  }));

  // Attach _meta before schema validation (model prompt does not include _meta)
  const outputWithMeta = {
    ...(parsed as Record<string, unknown>),
    analysis_status: inputTruncated ? "partial" : "complete",
    is_authoritative: false,
    heuristic_signals: heuristicSignals.length > 0 ? heuristicSignals : undefined,
    _meta: {
      provider,
      model: config.modelName,
      tokens_used: usage?.total_tokens ?? 0,
      prompt_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      input_truncated: inputTruncated,
      fallback_used: false,
      analysis_status: inputTruncated ? "partial" : "complete",
      ...traceMeta,
      ...buildDiagnosticMeta({
        analysisMode: "model_analysis",
        modelUsed: true,
        modelAttempted: true,
        limitations: inputTruncated ? ["Diff was truncated, some changes may not have been reviewed"] : undefined,
      }),
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
  provider: string,
  traceMeta: ReturnType<typeof createTraceMeta>,
): CallToolResult {
  log.info("review-diff: using heuristic fallback");

  const fallbackResult = reviewDiffFallback(diff, maxChars);

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
      ...traceMeta,
      ...buildDiagnosticMeta({
        analysisMode: "heuristic_fallback",
        modelUsed: false,
        modelAttempted: false,
        modelSkipReason: "model_not_configured",
        limitations: ["Pattern-based review only, no semantic analysis"],
      }),
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(outputData) }],
    isError: false,
  };
  } // handleImpl
}
