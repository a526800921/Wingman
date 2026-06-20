/**
 * Shared batching logic — decides whether to split input for model calls.
 *
 * Rule: small input → single call; large input → batch by tool-specific bounds.
 */

import type { BatchSpec } from "./types.js";

/** Default single-call character budget. Tools may override. */
const DEFAULT_SINGLE_CALL_BUDGET = 12000;

/**
 * Decide whether input should be split into batches.
 */
export function needsBatching(
  estimatedPayloadChars: number,
  singleCallBudget: number = DEFAULT_SINGLE_CALL_BUDGET,
): boolean {
  return estimatedPayloadChars > singleCallBudget;
}

/**
 * Build a single-batch spec for small inputs.
 */
export function singleBatch(payload: string): BatchSpec {
  return {
    batches: [{ id: "batch-0", payload, estimated_chars: payload.length }],
    candidate_count: 1,
    sent_count: 1,
    omitted_by_budget: 0,
  };
}

/**
 * Build batch spec from pre-split chunks.
 * Each chunk becomes one batch; respects max_model_calls cap.
 */
export function batchFromChunks(
  chunks: Array<{ id: string; payload: string }>,
  maxModelCalls: number,
): BatchSpec {
  const capped = chunks.slice(0, maxModelCalls);
  return {
    batches: capped.map(c => ({
      id: c.id,
      payload: c.payload,
      estimated_chars: c.payload.length,
    })),
    candidate_count: chunks.length,
    sent_count: capped.length,
    omitted_by_budget: Math.max(0, chunks.length - maxModelCalls),
  };
}
