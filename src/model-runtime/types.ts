/**
 * Shared model runtime types — used across all tool handlers.
 */

/** Unified analysis status for all tools. */
export type AnalysisStatus = "complete" | "partial" | "incomplete";

/** Evidence verification result. */
export type EvidenceVerdict = "verified" | "partial" | "unverified";

/** Why the model was skipped (if applicable). */
export type ModelSkipReason =
  | "model_not_configured"
  | "model_unavailable"
  | "explicitly_disabled"
  | "deterministic_fast_path"
  | "input_empty";

/** Model execution metadata — produced by every tool handler. */
export interface ModelExecutionMeta {
  model_attempted: boolean;
  model_skip_reason?: ModelSkipReason;
  model_failure_reason?: string;
  candidate_batches: number;
  batches_sent: number;
  batches_succeeded: number;
  batches_failed: number;
  batches_omitted_by_budget: number;
  model_calls_attempted: number;
  network_attempts?: number;
  input_truncated: boolean;
  fallback_used: boolean;
}

/** Specification for a batch of model calls. */
export interface BatchSpec {
  batches: Array<{
    id: string;
    /** Payload sent to model (serialized). */
    payload: string;
    estimated_chars: number;
  }>;
  candidate_count: number;
  sent_count: number;
  omitted_by_budget: number;
}
