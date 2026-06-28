/**
 * aux_summarize_file MCP tool handler.
 *
 * Orchestrates input validation, safe-path resolution, model-based
 * summarization (with automatic fallback to heuristic), and output
 * validation before returning a structured CallToolResult.
 */

import { readFileSync } from "node:fs";
import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
import { modelPathStatus, fallbackStatus } from "../model-runtime/status.js";
import { createTraceMeta } from "../logger.js";
import { hasApiKey, isModelAvailable, type ConfigLike } from "../shared/config-guard.js";
import { createTraceContext, withDuration, assembleBaseMeta } from "../shared/handler-boilerplate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function successResult(payload: SummarizeFileOutput): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false };
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
  config: ConfigLike,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const { tid, traceMeta, log } = createTraceContext("aux_summarize_file");

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
    await withDuration(tid, "summarize_file done", t0);
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

  const provider = hasApiKey(config)
    ? config.modelProvider
    : process.env.AUX_MODEL_PROVIDER ?? "remote";

  const modelAvailable = isModelAvailable(config);

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
      traceMeta,
    );
  } else {
    log.info("summarize_file: model not available, using fallback", {
      path: validatedInput.path,
    });
    result = buildFallbackResult(
      config.workspaceRoot,
      validatedInput.path,
      fileContent,
      maxChars,
      inputTruncated,
      provider,
      traceMeta,
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
  traceMeta: ReturnType<typeof createTraceMeta>,
): Promise<SummarizeFileOutput> {
  const client = new ChatClient(config);

  const systemPrompt = buildSummarizeFileSystemPrompt();
  const userMessage = buildSummarizeFileUserMessage(fileContent, focus);

  try {
    // Step 5c: call the model
    const { text: rawResponse, usage } = await client.chat(systemPrompt, userMessage);

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
      return buildFallbackResult(config.workspaceRoot, userPath, fileContent, maxChars, inputTruncated, provider, traceMeta, true);
    }

    // Step 5e½: normalize model output — tolerant camelCase + missing defaults
    // Qwen and other models may produce camelCase keys or omit must_verify_in_source.
    // We repair these before validation so legitimate semantic output isn't rejected.
    const parsedObj = parsed as Record<string, unknown>;

    // Normalize known camelCase → snake_case field names
    const CAMEL_CASE_MAP: Record<string, string> = {
      mustVerifyInSource: "must_verify_in_source",
      isAuthoritative: "is_authoritative",
      importantSymbols: "important_symbols",
      fileKind: "file_kind",
      importantSections: "important_sections",
      testCases: "test_cases",
      coveredBehaviors: "covered_behaviors",
      heuristicSignals: "heuristic_signals",
    };
    for (const [camel, snake] of Object.entries(CAMEL_CASE_MAP)) {
      if (snake in parsedObj || !(camel in parsedObj)) continue;
      parsedObj[snake] = parsedObj[camel];
      delete parsedObj[camel];
    }

    // must_verify_in_source: default to true when missing (safe default)
    if (!("must_verify_in_source" in parsedObj)) {
      parsedObj.must_verify_in_source = true;
    }

    // important_symbols[*].kind: map unrecognized values to "unknown"
    // (also handles models that output "property", "variable", etc. for non-TS languages)
    const VALID_SYMBOL_KINDS = new Set([
      "function", "class", "struct", "interface", "type", "const", "enum",
      "property", "variable", "method", "unknown",
    ]);
    const symbols = parsedObj.important_symbols;
    if (Array.isArray(symbols)) {
      let normalizedKindCount = 0;
      for (const s of symbols) {
        if (typeof s !== "object" || s === null) continue;
        const sym = s as Record<string, unknown>;
        if (typeof sym.kind === "string" && !VALID_SYMBOL_KINDS.has(sym.kind)) {
          sym.kind = "unknown";
          normalizedKindCount++;
        }
      }
      if (normalizedKindCount > 0) {
        log.info("summarize_file: normalized unrecognized symbol kinds to 'unknown'", {
          normalizedKindCount,
          totalSymbols: symbols.length,
        });
      }
    }

    // Step 5f: evidence verification + attach _meta
    let evidenceRejectedCount: number | undefined;
    const modelSymbols = (parsed as Record<string, unknown>).important_symbols;
    if (Array.isArray(modelSymbols)) {
      const unverified = modelSymbols.filter(
        (s: unknown) => typeof (s as Record<string, unknown>).name === "string" &&
          !fileContent.includes((s as Record<string, unknown>).name as string)
      );
      if (unverified.length > 0) {
        evidenceRejectedCount = unverified.length;
        log.warn("summarize_file: evidence verification — symbol names not found in source", {
          unverifiedNames: unverified.map((s: unknown) => (s as Record<string, unknown>).name),
          totalSymbols: modelSymbols.length,
        });
      }
    }

    const outputWithMeta = {
      ...(parsed as Record<string, unknown>),
      analysis_status: modelPathStatus(true, false, inputTruncated),
      is_authoritative: false,
      _meta: assembleBaseMeta({
        provider,
        modelName: config.modelName,
        totalTokens: usage?.total_tokens ?? 0,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        inputTruncated,
        fallbackUsed: false,
        analysisMode: "model_analysis",
        modelUsed: true,
        modelAttempted: true,
        limitations: inputTruncated ? ["File was truncated, some content may not have been analyzed"] : undefined,
        traceMeta,
        overrides: {
          analysis_status: modelPathStatus(true, false, inputTruncated),
          ...(evidenceRejectedCount !== undefined ? {
            feedback_recommended: evidenceRejectedCount > 0 || inputTruncated,
            feedback_reason: evidenceRejectedCount > 0 ? "evidence_rejected" as const : (inputTruncated ? "partial_analysis" as const : undefined),
          } : {}),
        },
      }),
    };

    // Step 5g: validate output schema (after _meta is attached)
    const outputValidation = validateOutput("aux_summarize_file", outputWithMeta);
    if (!outputValidation.ok) {
      log.warn(
        "summarize_file: model output failed schema validation, falling back to heuristic",
        { error: outputValidation.error },
      );
      return buildFallbackResult(config.workspaceRoot, userPath, fileContent, maxChars, inputTruncated, provider, traceMeta, true);
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

    return buildFallbackResult(config.workspaceRoot, userPath, fileContent, maxChars, inputTruncated, provider, traceMeta, true);
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
  fileContent: string,
  maxChars: number,
  inputTruncated: boolean,
  provider: string,
  traceMeta: ReturnType<typeof createTraceMeta>,
  modelAttempted = false,
): SummarizeFileOutput {
  // If we were already in the fallback path (model unavailable), the
  // relativePath is the original user path and can be used directly.
  // If we fell through from a model failure, we re-use the path.
  let fallbackData;

  try {
    fallbackData = summarizeFileFallback(workspaceRoot, relativePath, maxChars, fileContent);
  } catch (err: unknown) {
    // summarizeFileFallback itself failed — this is unexpected, but we
    // produce a minimal valid result rather than throwing.
    const message = err instanceof Error ? err.message : String(err);
    log.error("summarize_file: fallback summarizer itself failed", {
      error: message,
    });
    const skipReason = modelAttempted ? undefined : "model_not_configured";
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
      analysis_status: fallbackStatus(skipReason ?? "model_unavailable", false),
      _meta: assembleBaseMeta({
          provider,
          modelName: "heuristic",
          totalTokens: 0,
          promptTokens: undefined,
          completionTokens: undefined,
          inputTruncated,
          fallbackUsed: true,
          analysisMode: "heuristic_fallback",
          modelUsed: false,
          modelAttempted,
          modelSkipReason: skipReason,
          limitations: ["Deterministic mechanical scan failed — no analysis performed. Read the file directly."],
          traceMeta,
          overrides: { analysis_status: fallbackStatus(skipReason ?? "model_unavailable", false) },
        }),
    };
  }

  const skipReason = modelAttempted ? undefined : "model_not_configured";
  return {
    summary: fallbackData.summary,
    analysis_status: fallbackStatus(skipReason ?? "model_unavailable", false),
    file_kind: fallbackData.file_kind,
    important_symbols: fallbackData.important_symbols,
    important_sections: fallbackData.important_sections,
    test_cases: fallbackData.test_cases,
    covered_behaviors: fallbackData.covered_behaviors,
    heuristic_signals: fallbackData.heuristic_signals,
    evidence: fallbackData.evidence,
    uncertainties: fallbackData.uncertainties,
    must_verify_in_source: fallbackData.must_verify_in_source,
    is_authoritative: fallbackData.is_authoritative,
    _meta: assembleBaseMeta({
      provider,
      modelName: "heuristic",
      totalTokens: 0,
      promptTokens: undefined,
      completionTokens: undefined,
      inputTruncated,
      fallbackUsed: true,
      analysisMode: "heuristic_fallback",
      modelUsed: false,
      modelAttempted,
      modelSkipReason: skipReason,
      limitations: ["Deterministic mechanical scan only — no semantic analysis performed. Use model-based summarizer or read the file directly."],
      traceMeta,
      overrides: { analysis_status: fallbackStatus(skipReason ?? "model_unavailable", false) },
    }),
  };
  } // handleImpl
}
