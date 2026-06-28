/**
 * Shared model runtime types — used by status.ts.
 */

/** Unified analysis status for all tools. */
export type AnalysisStatus = "complete" | "partial" | "incomplete";

/** Why the model was skipped (if applicable). */
export type ModelSkipReason =
  | "model_not_configured"
  | "model_unavailable"
  | "explicitly_disabled"
  | "deterministic_fast_path"
  | "input_empty";
