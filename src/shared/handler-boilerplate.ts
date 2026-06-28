/**
 * Shared handler boilerplate — trace context and _meta assembly.
 *
 * Every tool handler repeats the same 8-10 lines of trace setup
 * (createTraceId + createTraceMeta + traceLogger + logDuration wrapper)
 * and the same _meta assembly pattern (provider/model/tokens +
 * input_truncated + fallback_used + buildDiagnosticMeta spread + traceMeta).
 *
 * These helpers eliminate that repetition without introducing a
 * full handler framework — each handler retains its own model call
 * and fallback path.
 */

import type { ResultMeta } from "../schema.js";
import { createTraceId, createTraceMeta, traceLogger, logDuration } from "../logger.js";
import { buildDiagnosticMeta, type BuildDiagnosticMetaParams } from "../model-runtime/diagnostics.js";

// ---------------------------------------------------------------------------
// Trace context
// ---------------------------------------------------------------------------

export interface TraceContext {
  tid: string;
  traceMeta: ReturnType<typeof createTraceMeta>;
  log: ReturnType<typeof traceLogger>;
}

/** One-liner for the trace boilerplate that opens every handler. */
export function createTraceContext(toolName: string): TraceContext {
  const tid = createTraceId();
  return {
    tid,
    traceMeta: createTraceMeta(tid, toolName),
    log: traceLogger(tid),
  };
}

/** Wraps the main handler logic with duration logging. */
export async function withDuration(
  tid: string,
  label: string,
  t0: number,
): Promise<void> {
  logDuration(tid, label, t0);
}

// ---------------------------------------------------------------------------
// _meta assembly
// ---------------------------------------------------------------------------

export interface AssembleMetaParams {
  provider: string;
  modelName: string;
  totalTokens: number;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  inputTruncated: boolean;
  fallbackUsed: boolean;
  analysisMode: BuildDiagnosticMetaParams["analysisMode"];
  modelUsed: boolean;
  modelAttempted: boolean;
  modelFailureReason?: string;
  modelSkipReason?: string;
  confidence?: BuildDiagnosticMetaParams["confidence"];
  limitations?: string[];
  traceMeta: ReturnType<typeof createTraceMeta>;
  /** Tool-specific metadata fields to merge on top. */
  overrides?: Partial<Record<string, unknown>>;
}

/**
 * Assemble the shared portion of a tool's _meta object.
 * Returns a plain object for the caller to merge into their output.
 * Callers spread this and add any tool-specific fields (chunking, batch counts, etc.).
 */
export function assembleBaseMeta(params: AssembleMetaParams): ResultMeta & Record<string, unknown> {
  const feedbackRecommended = params.fallbackUsed || params.inputTruncated;
  let feedbackReason: ResultMeta["feedback_reason"];
  if (params.fallbackUsed) feedbackReason = "fallback_used";
  else if (params.inputTruncated) feedbackReason = "partial_analysis";

  return {
    provider: params.provider,
    model: params.modelName,
    tokens_used: params.totalTokens,
    prompt_tokens: params.promptTokens,
    completion_tokens: params.completionTokens,
    input_truncated: params.inputTruncated,
    fallback_used: params.fallbackUsed,
    feedback_recommended: feedbackRecommended || undefined,
    feedback_reason: feedbackReason,
    analysis_status: undefined, // set by caller (varies by tool)
    ...params.traceMeta,
    ...buildDiagnosticMeta({
      analysisMode: params.analysisMode,
      modelUsed: params.modelUsed,
      modelAttempted: params.modelAttempted,
      modelSkipReason: params.modelSkipReason,
      modelFailureReason: params.modelFailureReason,
      confidence: params.confidence,
      limitations: params.limitations,
    }),
    ...params.overrides,
  };
}
