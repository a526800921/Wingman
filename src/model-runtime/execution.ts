/**
 * Shared model execution — handles single/batch calls, concurrency, retries.
 *
 * Tools provide:
 *   - payload: the text to send
 *   - systemPrompt + userMessage builder
 *   - response validator (Zod schema)
 *
 * This module handles:
 *   - model availability check
 *   - single vs batch dispatch
 *   - concurrency limits
 *   - success/failure tracking
 *   - retry counting (via network_attempts)
 */

import type { BatchSpec, ModelExecutionMeta } from "./types.js";

/** Default concurrency for batch model calls. */
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;

export interface ModelCallConfig {
  concurrency?: number;
  max_model_calls?: number;
}

export interface ModelCallFn {
  (systemPrompt: string, userMessage: string): Promise<string>;
}

/**
 * Execute a single model call.
 */
export async function executeSingleCall(
  callModel: ModelCallFn,
  systemPrompt: string,
  userMessage: string,
): Promise<{ rawResponse: string; meta: ModelExecutionMeta }> {
  let networkAttempts = 0;
  let succeeded = false;
  let failureReason: string | undefined;

  try {
    const raw = await callModel(systemPrompt, userMessage);
    succeeded = true;
    networkAttempts = 1;

    return {
      rawResponse: raw,
      meta: {
        model_attempted: true,
        candidate_batches: 1,
        batches_sent: 1,
        batches_succeeded: 1,
        batches_failed: 0,
        batches_omitted_by_budget: 0,
        model_calls_attempted: 1,
        network_attempts: networkAttempts,
        input_truncated: false,
        fallback_used: false,
      },
    };
  } catch (err) {
    failureReason = err instanceof Error ? err.message : String(err);
    return {
      rawResponse: "",
      meta: {
        model_attempted: true,
        model_failure_reason: failureReason,
        candidate_batches: 1,
        batches_sent: 1,
        batches_succeeded: 0,
        batches_failed: 1,
        batches_omitted_by_budget: 0,
        model_calls_attempted: 1,
        network_attempts: 1,
        input_truncated: false,
        fallback_used: false,
      },
    };
  }
}

/**
 * Execute model calls for a batch spec with limited concurrency.
 * Returns accumulated responses and metadata.
 */
export async function executeBatchedCalls(
  callModel: ModelCallFn,
  systemPrompt: string,
  buildUserMessage: (batch: { id: string; payload: string }) => string,
  batchSpec: BatchSpec,
  config: ModelCallConfig = {},
): Promise<{
  responses: Array<{ batchId: string; raw: string }>;
  meta: ModelExecutionMeta;
}> {
  const concurrency = Math.min(config.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
  const maxCalls = config.max_model_calls ?? 5;
  const capped = batchSpec.batches.slice(0, maxCalls);

  const responses: Array<{ batchId: string; raw: string }> = [];
  let succeeded = 0;
  let failed = 0;
  let networkAttempts = 0;

  for (let i = 0; i < capped.length; i += concurrency) {
    const slice = capped.slice(i, i + concurrency);
    const promises = slice.map(async (batch) => {
      try {
        const userMsg = buildUserMessage(batch);
        const raw = await callModel(systemPrompt, userMsg);
        networkAttempts++;
        succeeded++;
        return { batchId: batch.id, raw };
      } catch {
        networkAttempts++;
        failed++;
        return null;
      }
    });
    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        responses.push(r.value);
      }
    }
  }

  return {
    responses,
    meta: {
      model_attempted: true,
      candidate_batches: batchSpec.candidate_count,
      batches_sent: capped.length,
      batches_succeeded: succeeded,
      batches_failed: failed,
      batches_omitted_by_budget: batchSpec.omitted_by_budget,
      model_calls_attempted: capped.length,
      network_attempts: networkAttempts,
      input_truncated: false,
      fallback_used: false,
    },
  };
}

/**
 * Build a complete ModelExecutionMeta for the fallback path.
 */
export function fallbackMeta(reason: string): ModelExecutionMeta {
  return {
    model_attempted: false,
    model_skip_reason: reason as ModelExecutionMeta["model_skip_reason"],
    candidate_batches: 0,
    batches_sent: 0,
    batches_succeeded: 0,
    batches_failed: 0,
    batches_omitted_by_budget: 0,
    model_calls_attempted: 0,
    input_truncated: false,
    fallback_used: true,
  };
}
