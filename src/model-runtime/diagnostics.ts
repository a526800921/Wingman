/**
 * Unified diagnostic metadata builder.
 *
 * Constructs the 6 unified `_meta` diagnostic fields shared across all tools.
 * Tools pass their specific context, this helper computes consistent values.
 *
 * INTENT: tools must NOT hand-write these 6 fields individually — they call
 * this helper and spread the return into their `_meta`.
 */

/** Analysis mode — how the tool produced its output. */
export type AnalysisMode =
  | "model_analysis"
  | "heuristic_fallback"
  | "mixed"
  | "unsupported";

/** Overall output confidence (NOT finding-level). */
export type OutputConfidence = "high" | "medium" | "low";

export interface BuildDiagnosticMetaParams {
  /** How the tool produced its output. */
  analysisMode: AnalysisMode;
  /** Whether the final output uses model results (distinct from model_attempted). */
  modelUsed: boolean;
  /** Whether a model call was attempted. */
  modelAttempted: boolean;
  /** Why the model was not attempted (if applicable). */
  modelSkipReason?: string;
  /** Why the model failed (if applicable). */
  modelFailureReason?: string;
  /** Overall output confidence. Defaults based on analysis_mode if omitted. */
  confidence?: OutputConfidence;
  /** Limitations the caller must know. */
  limitations?: string[];
}

export interface DiagnosticMeta {
  model_attempted: boolean;
  model_used: boolean;
  model_skip_reason?: string;
  model_failure_reason?: string;
  analysis_mode: AnalysisMode;
  confidence: OutputConfidence;
  limitations?: string[];
}

/**
 * Default confidence by analysis mode.
 */
function defaultConfidence(mode: AnalysisMode): OutputConfidence {
  switch (mode) {
    case "model_analysis":
      return "high";
    case "mixed":
      return "medium";
    case "heuristic_fallback":
      return "low";
    case "unsupported":
      return "low";
  }
}

/**
 * Build the 6 unified diagnostic `_meta` fields from tool-specific context.
 *
 * Tools call this and spread the result into their `_meta` objects alongside
 * any tool-specific fields (chunking, batch counts, etc.).
 */
export function buildDiagnosticMeta(
  params: BuildDiagnosticMetaParams,
): DiagnosticMeta {
  const confidence = params.confidence ?? defaultConfidence(params.analysisMode);

  return {
    model_attempted: params.modelAttempted,
    model_used: params.modelUsed,
    model_skip_reason: params.modelSkipReason,
    model_failure_reason: params.modelFailureReason,
    analysis_mode: params.analysisMode,
    confidence,
    limitations: params.limitations,
  };
}
