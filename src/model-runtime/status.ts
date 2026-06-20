/**
 * Analysis status helpers — consistent status computation across all tools.
 */

import type { AnalysisStatus, ModelSkipReason } from "./types.js";

/**
 * Determine analysis status for a model path result.
 */
export function modelPathStatus(
  succeeded: boolean,
  partialBatchFailure: boolean,
  inputTruncated: boolean,
): AnalysisStatus {
  if (!succeeded) return "incomplete";
  if (partialBatchFailure || inputTruncated) return "partial";
  return "complete";
}

/**
 * Determine analysis status for a fallback/heuristic path result.
 * Heuristic-only results are never "complete" — they lack model semantic analysis.
 */
export function fallbackStatus(
  skipReason: ModelSkipReason,
  hasFindings: boolean,
): AnalysisStatus {
  if (skipReason === "input_empty") return "complete"; // nothing to analyze
  if (hasFindings) return "partial";  // heuristic found signals but no model
  return "incomplete";                // nothing found, analysis not done
}
