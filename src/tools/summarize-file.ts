/**
 * aux_summarize_file MCP tool handler.
 *
 * Orchestrates input validation, safe-path resolution, model-based
 * summarization (with automatic fallback to heuristic), and output
 * validation before returning a structured CallToolResult.
 */

import { readFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
import { logger } from "../logger.js";

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
  // ---- Step 1: validate input ----------------------------------------------
  const inputValidation = validateInput("aux_summarize_file", input);
  if (!inputValidation.ok) {
    return errorResult(`Invalid input: ${inputValidation.error}`);
  }
  const validatedInput = inputValidation.data as SummarizeFileInput;

  // ---- Step 2: resolve safe path -------------------------------------------
  let resolvedPath: string;
  try {
    resolvedPath = resolveSafePath(config.workspaceRoot, validatedInput.path);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("summarize_file: path resolution failed", {
      userPath: validatedInput.path,
      error: message,
    });
    return errorResult(`Access denied: ${message}`);
  }

  // ---- Step 3: read file content -------------------------------------------
  let rawText: string;
  try {
    rawText = readFileSync(resolvedPath, { encoding: "utf-8" });
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      logger.info("summarize_file: file not found", {
        resolvedPath,
        userPath: validatedInput.path,
      });
      return errorResult(`File not found: ${validatedInput.path}`);
    }
    logger.error("summarize_file: failed to read file", {
      resolvedPath,
      error: nodeErr.message,
    });
    return errorResult(`Failed to read file: ${nodeErr.message}`);
  }

  // Truncate if the file exceeds the character limit.
  const maxChars = validatedInput.max_chars ?? DEFAULT_MAX_READ_CHARS;
  const inputTruncated = rawText.length > maxChars;
  const fileContent = inputTruncated ? rawText.slice(0, maxChars) : rawText;

  if (inputTruncated) {
    logger.info("summarize_file: file truncated", {
      path: validatedInput.path,
      originalLength: rawText.length,
      maxChars,
    });
  }

  // ---- Step 4-5: model-based or fallback summarization ---------------------

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
    );
  } else {
    logger.info("summarize_file: model not available, using fallback", {
      path: validatedInput.path,
    });
    result = buildFallbackResult(
      config.workspaceRoot,
      validatedInput.path,
      maxChars,
      inputTruncated,
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
      logger.warn(
        "summarize_file: model returned non-JSON, falling back to heuristic",
      );
      return buildFallbackResult(config.workspaceRoot, userPath, maxChars, inputTruncated);
    }

    // Step 5f: validate output schema
    const outputValidation = validateOutput("aux_summarize_file", parsed);
    if (!outputValidation.ok) {
      logger.warn(
        "summarize_file: model output failed schema validation, falling back to heuristic",
        { error: outputValidation.error },
      );
      return buildFallbackResult(config.workspaceRoot, userPath, maxChars, inputTruncated);
    }

    // Step 5h: success — attach _meta
    const validatedOutput = outputValidation.data as SummarizeFileOutput;

    logger.info("summarize_file: model summarization succeeded", {
      model: config.modelName,
      inputTruncated,
    });

    return {
      ...validatedOutput,
      _meta: {
        model: config.modelName,
        input_truncated: inputTruncated,
        fallback_used: false,
      },
    };
  } catch (err: unknown) {
    // Step 5g: any exception during model call falls through to fallback
    const message =
      err instanceof ChatClientError
        ? `[${err.code}] ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

    logger.warn(
      "summarize_file: model call failed, falling back to heuristic",
      { error: message },
    );

    return buildFallbackResult(config.workspaceRoot, userPath, maxChars, inputTruncated);
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
    logger.error("summarize_file: fallback summarizer itself failed", {
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
      _meta: {
        model: "heuristic",
        tokens_used: 0,
        input_truncated: inputTruncated,
        fallback_used: true,
      },
    };
  }

  return {
    summary: fallbackData.summary,
    important_symbols: fallbackData.important_symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      role: s.role,
      location: s.location,
    })),
    evidence: fallbackData.evidence,
    uncertainties: fallbackData.uncertainties,
    must_verify_in_source: fallbackData.must_verify_in_source,
    is_authoritative: fallbackData.is_authoritative,
    _meta: {
      model: "heuristic",
      tokens_used: 0,
      input_truncated: inputTruncated,
      fallback_used: true,
    },
  };
}
