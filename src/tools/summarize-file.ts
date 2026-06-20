/**
 * aux_summarize_file MCP tool handler.
 *
 * Orchestrates input validation, safe-path resolution, model-based
 * summarization (with automatic fallback to heuristic), and output
 * validation before returning a structured CallToolResult.
 */

import { readFileSync } from "node:fs";
import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, loadConfigFallback, hasModelConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import { ChatClient, ChatClientError } from "../chat-client.js";
import { resolveSafePath, DEFAULT_MAX_READ_CHARS } from "../workspace.js";
import {
  validateInput,
  validateOutput,
} from "../schema.js";
import type { SummarizeFileInput, SummarizeFileOutput } from "../schema.js";
import {
  buildSummarizeFileSystemPrompt,
  buildSummarizeFileUserMessage,
  extractJsonFromResponse,
} from "../prompts.js";
import {
  summarizeFileFallback,
} from "../fallback/summarize-file.js";
import { splitPrefixSuffix, joinPrefixSuffix } from "../model-runtime/truncation.js";
import { createTraceId, traceLogger, logDuration } from "../logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether `config` is a full AppConfig with model-related fields
 * (duck-typing — `loadConfigFallback` only returns `{ workspaceRoot }`).
 */
function isFullConfig(
  config: ReturnType<typeof loadConfig> | ReturnType<typeof loadConfigFallback>,
): config is AppConfig {
  return "modelApiKey" in config && typeof (config as AppConfig).modelApiKey === "string";
}

/**
 * Build an error CallToolResult with a single text content block.
 */
function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Build a successful CallToolResult with the given JSON-serializable payload.
 */
function successResult(payload: SummarizeFileOutput): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
  };
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

/**
 * Handle the `aux_summarize_file` MCP tool call.
 *
 * Flow:
 * 1. Validate input against SummarizeFileInput schema.
 * 2. Resolve the user-supplied path against the workspace root (hardened).
 * 3. Read the file content, truncating to `max_chars` if needed.
 * 4. If model is available, attempt model-based summarization.
 * 5. On any model failure, fall back to heuristic summarization.
 * 6. Validate the output against SummarizeFileOutput schema.
 * 7. Return a structured CallToolResult.
 */
export async function handleSummarizeFile(
  input: unknown,
  config: ReturnType<typeof loadConfig> | ReturnType<typeof loadConfigFallback>,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const tid = createTraceId();
  const log = traceLogger(tid);

  // ---- Step 1: validate input ----------------------------------------------
  const inputValidation = validateInput("aux_summarize_file", input);
  if (!inputValidation.ok) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${inputValidation.error}`);
  }
  const validatedInput = inputValidation.data as SummarizeFileInput;

  log.info("summarize_file start", {
    path: validatedInput.path,
    focus: validatedInput.focus ?? undefined,
    max_chars: validatedInput.max_chars,
  });

  try {
    return await handleImpl();
  } finally {
    logDuration(tid, "summarize_file done", t0);
  }

  async function handleImpl(): Promise<CallToolResult> {
  // ---- Step 2: resolve safe path -------------------------------------------
  let resolvedPath: string;
  try {
    resolvedPath = resolveSafePath(config.workspaceRoot, validatedInput.path);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("summarize_file: path resolution failed", {
      userPath: validatedInput.path,
      error: message,
    });
    throw new McpError(ErrorCode.InvalidParams, `Access denied: ${message}`);
  }

  // ---- Step 3: read file content -------------------------------------------
  let rawText: string;
  try {
    rawText = readFileSync(resolvedPath, { encoding: "utf-8" });
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      log.info("summarize_file: file not found", {
        resolvedPath,
        userPath: validatedInput.path,
      });
      return errorResult(`File not found: ${validatedInput.path}`);
    }
    log.error("summarize_file: failed to read file", {
      resolvedPath,
      error: nodeErr.message,
    });
    return errorResult(`Failed to read file: ${nodeErr.message}`);
  }

  // Truncate if the file exceeds the character limit.
  const maxChars = validatedInput.max_chars ?? DEFAULT_MAX_READ_CHARS;
  const inputTruncated = rawText.length > maxChars;
  // P3: smart truncation — preserve both prefix and suffix so tail content is not lost
  const { prefix, suffix, omittedChars } = splitPrefixSuffix(rawText, maxChars);
  const fileContent = inputTruncated ? joinPrefixSuffix(prefix, suffix, omittedChars) : rawText;

  if (inputTruncated) {
    log.info("summarize_file: file truncated", {
      path: validatedInput.path,
      originalLength: rawText.length,
      maxChars,
    });
  }

  // ---- Step 4-5: model-based or fallback summarization ---------------------

  const provider = isFullConfig(config)
    ? (config as AppConfig).modelProvider
    : process.env.AUX_MODEL_PROVIDER ?? "remote";

  const modelAvailable =
    isFullConfig(config) &&
    hasModelConfig() &&
    new ChatClient(config).isAvailable();

  let result: SummarizeFileOutput;

  if (modelAvailable) {
    result = await tryModelSummarization(
      config as AppConfig,
      fileContent,
      validatedInput.path,
      validatedInput.focus,
      maxChars,
      inputTruncated,
      provider,
    );
  } else {
    log.info("summarize_file: model not available, using fallback", {
      path: validatedInput.path,
    });
    result = buildFallbackResult(
      config.workspaceRoot,
      validatedInput.path,
      maxChars,
      inputTruncated,
      provider,
    );
  }

  // ---- Step 7: return structured result ------------------------------------
  return successResult(result);
}

// ---------------------------------------------------------------------------
// Model summarization attempt (with automatic fallback on any failure)
// ---------------------------------------------------------------------------

async function tryModelSummarization(
  config: AppConfig,
  fileContent: string,
  userPath: string,
  focus: string | undefined,
  maxChars: number,
  inputTruncated: boolean,
  provider: string,
): Promise<SummarizeFileOutput> {
  const client = new ChatClient(config);

  const systemPrompt = buildSummarizeFileSystemPrompt();
  const userMessage = buildSummarizeFileUserMessage(fileContent, focus);

  try {
    // Step 5c: call the model
    const rawResponse = await client.chat(systemPrompt, userMessage);

    // Step 5d: extract JSON from the response
    const jsonString = extractJsonFromResponse(rawResponse);

    // Step 5e: parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonString);
    } catch {
      log.warn(
        "summarize_file: model returned non-JSON, falling back to heuristic",
      );
      return buildFallbackResult(config.workspaceRoot, userPath, maxChars, inputTruncated, provider);
    }

    // Step 5f: attach _meta + force is_authoritative (model prompt does not include _meta)
    const outputWithMeta = {
      ...(parsed as Record<string, unknown>),
      analysis_status: inputTruncated ? "partial" : "complete",
      is_authoritative: false,
      _meta: {
        provider,
        model: config.modelName,
        input_truncated: inputTruncated,
        fallback_used: false,
      },
    };

    // Step 5g: validate output schema (after _meta is attached)
    const outputValidation = validateOutput("aux_summarize_file", outputWithMeta);
    if (!outputValidation.ok) {
      log.warn(
        "summarize_file: model output failed schema validation, falling back to heuristic",
        { error: outputValidation.error },
      );
      return buildFallbackResult(config.workspaceRoot, userPath, maxChars, inputTruncated, provider);
    }

    log.info("summarize_file: model summarization succeeded", {
      model: config.modelName,
      inputTruncated,
    });

    return outputValidation.data as SummarizeFileOutput;
  } catch (err: unknown) {
    // Step 5g: any exception during model call falls through to fallback
    const message =
      err instanceof ChatClientError
        ? `[${err.code}] ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

    log.warn(
      "summarize_file: model call failed, falling back to heuristic",
      { error: message },
    );

    return buildFallbackResult(config.workspaceRoot, userPath, maxChars, inputTruncated, provider);
  }
}

// ---------------------------------------------------------------------------
// Fallback result construction
// ---------------------------------------------------------------------------

/**
 * Build a SummarizeFileOutput using the heuristic summarizer.
 *
 * Always receives the original user-supplied relative path so the
 * fallback can re-read the file from disk if needed.
 */
function buildFallbackResult(
  workspaceRoot: string,
  relativePath: string,
  maxChars: number,
  inputTruncated: boolean,
  provider: string,
): SummarizeFileOutput {
  // If we were already in the fallback path (model unavailable), the
  // relativePath is the original user path and can be used directly.
  // If we fell through from a model failure, we re-use the path.
  let fallbackData;

  try {
    fallbackData = summarizeFileFallback(workspaceRoot, relativePath, maxChars);
  } catch (err: unknown) {
    // summarizeFileFallback itself failed — this is unexpected, but we
    // produce a minimal valid result rather than throwing.
    const message = err instanceof Error ? err.message : String(err);
    log.error("summarize_file: fallback summarizer itself failed", {
      error: message,
    });
    return {
      summary: `Failed to summarize file: ${message}`,
      important_symbols: [],
      evidence: [],
      uncertainties: [
        {
          topic: "Summarization failure",
          reason: message,
          suggested_verification: "Review the file manually.",
        },
      ],
      must_verify_in_source: true,
      is_authoritative: false,
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
  }

  return {
    summary: fallbackData.summary,
    analysis_status: "partial" as const,
    file_kind: fallbackData.file_kind,
    important_symbols: fallbackData.important_symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      role: s.role,
      location: s.location,
    })),
    important_sections: fallbackData.important_sections,
    test_cases: fallbackData.test_cases,
    covered_behaviors: fallbackData.covered_behaviors,
    evidence: fallbackData.evidence,
    uncertainties: fallbackData.uncertainties,
    must_verify_in_source: fallbackData.must_verify_in_source,
    is_authoritative: fallbackData.is_authoritative,
    _meta: {
      provider,
      model: "heuristic",
      tokens_used: 0,
      input_truncated: inputTruncated,
      fallback_used: true,
    },
  };
  } // handleImpl
}
