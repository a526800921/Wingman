/**
 * Schema snapshot tests: analysis_status + _meta consistency.
 *
 * Verifies:
 *  1. analysis_status has no Zod .default() → missing field = validation failure
 *  2. All 5 tool _meta shapes contain every ResultMetaSchema field
 *  3. modelPathStatus / fallbackStatus edge cases
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateOutput,
  ResultMetaSchema,
  AnalysisStatusSchema,
  SummarizeFileOutput,
  CompressTextOutput,
  ReviewDiffOutput,
  ReviewDiffByFileOutput,
  CompressCommandOutputOutput,
} from "../src/schema.js";

import { modelPathStatus, fallbackStatus } from "../src/model-runtime/status.js";

// ---------------------------------------------------------------------------
// 1. analysis_status has no default — missing field = rejection
// ---------------------------------------------------------------------------

describe("analysis_status has no Zod default", () => {
  // Minimum valid SummarizeFileOutput (without analysis_status to test rejection)
  const minimalSummarize = {
    summary: "test",
    important_symbols: [],
    evidence: [],
    uncertainties: [],
    must_verify_in_source: true,
    is_authoritative: false,
    _meta: {
      model: "test",
      tokens_used: 0,
      input_truncated: false,
      fallback_used: false,
    },
  };

  it("rejects SummarizeFileOutput when analysis_status is missing", () => {
    const result = validateOutput("aux_summarize_file", minimalSummarize);
    assert.strictEqual(result.ok, false, "should reject missing analysis_status");
  });

  it("rejects CompressTextOutput when analysis_status is missing", () => {
    const minimal = {
      summary: "test",
      key_facts: [],
      discarded_or_low_confidence: [],
      must_verify_in_source: true,
      is_authoritative: false,
      _meta: { model: "test", tokens_used: 0, input_truncated: false, fallback_used: false },
    };
    const result = validateOutput("aux_compress_text", minimal);
    assert.strictEqual(result.ok, false, "should reject missing analysis_status");
  });

  it("rejects ReviewDiffOutput when analysis_status is missing", () => {
    const minimal = {
      change_summary: "test",
      possible_risks: [],
      suggested_source_checks: [],
      suggested_tests: [],
      uncertainties: [],
      is_authoritative: false,
      _meta: { model: "test", tokens_used: 0, input_truncated: false, fallback_used: false },
    };
    const result = validateOutput("aux_review_diff", minimal);
    assert.strictEqual(result.ok, false, "should reject missing analysis_status");
  });

  it("rejects ReviewDiffByFileOutput when analysis_status is missing", () => {
    const minimal = {
      overall_summary: "test",
      files: [],
      top_risks: [],
      omitted_files: [],
      is_authoritative: false,
      _meta: {
        model: "test",
        tokens_used: 0,
        input_truncated: false,
        fallback_used: false,
        chunking: { total_chunks: 1, analyzed_chunks: 1, omitted_chunks: 0, omitted: [], input_truncated: false, chunking_strategy: "none" },
      },
    };
    const result = validateOutput("aux_review_diff_by_file", minimal);
    assert.strictEqual(result.ok, false, "should reject missing analysis_status");
  });

  it("accepts outputs with explicit analysis_status", () => {
    const result = validateOutput("aux_summarize_file", {
      ...minimalSummarize,
      analysis_status: "complete",
    });
    assert.strictEqual(result.ok, true, "should accept explicit analysis_status");
  });
});

// ---------------------------------------------------------------------------
// 2. All tool _meta shapes contain all ResultMetaSchema fields
// ---------------------------------------------------------------------------

describe("_meta contains all ResultMetaSchema fields", () => {
  const sharedFields = Object.keys(ResultMetaSchema.shape);

  // Build a valid output for each tool with all optional _meta fields populated,
  // then validate and check that the parsed _meta contains all shared fields.
  const fullMeta = {
    provider: "openai",
    model: "gpt-4",
    tokens_used: 100,
    prompt_tokens: 50,
    completion_tokens: 50,
    input_truncated: false,
    fallback_used: false,
    analysis_status: "complete" as const,
    model_attempted: true,
    model_skip_reason: "",
    model_failure_reason: "",
    model_used: true,
    analysis_mode: "model_analysis" as const,
    confidence: "high" as const,
    limitations: [] as string[],
    trace_id: "abc123",
    tool_name: "test",
    feedback_recommended: true as const,
    feedback_reason: "fallback_used" as const,
  };

  function checkToolMeta(toolName: string, output: Record<string, unknown>) {
    const result = validateOutput(toolName, output);
    assert.ok(result.ok, `${toolName} should validate`);
    const meta = (result.data as Record<string, unknown>)?._meta as Record<string, unknown>;
    assert.ok(meta, `${toolName} should have _meta`);
    for (const field of sharedFields) {
      assert.ok(
        field in meta,
        `${toolName} _meta should have field "${field}"`,
      );
    }
  }

  it("aux_summarize_file _meta has all shared fields", () => {
    checkToolMeta("aux_summarize_file", {
      analysis_status: "complete",
      summary: "x",
      important_symbols: [],
      evidence: [],
      uncertainties: [],
      must_verify_in_source: true,
      is_authoritative: false,
      _meta: { ...fullMeta },
    });
  });

  it("aux_compress_text _meta has all shared fields", () => {
    checkToolMeta("aux_compress_text", {
      analysis_status: "complete",
      summary: "x",
      key_facts: [],
      discarded_or_low_confidence: [],
      must_verify_in_source: true,
      is_authoritative: false,
      _meta: { ...fullMeta },
    });
  });

  it("aux_review_diff _meta has all shared fields", () => {
    checkToolMeta("aux_review_diff", {
      analysis_status: "complete",
      change_summary: "x",
      possible_risks: [],
      suggested_source_checks: [],
      suggested_tests: [],
      uncertainties: [],
      is_authoritative: false,
      _meta: { ...fullMeta },
    });
  });

  it("aux_review_diff_by_file _meta has all shared fields", () => {
    checkToolMeta("aux_review_diff_by_file", {
      analysis_status: "complete",
      overall_summary: "x",
      files: [],
      top_risks: [],
      omitted_files: [],
      is_authoritative: false,
      _meta: { ...fullMeta, chunking: { total_chunks: 1, analyzed_chunks: 1, omitted_chunks: 0, omitted: [], input_truncated: false, chunking_strategy: "none" } },
    });
  });

  it("aux_compress_command_output _meta has all shared fields", () => {
    checkToolMeta("aux_compress_command_output", {
      summary: "x",
      analysis_status: "complete",
      findings: [],
      repeated_errors: [],
      suggested_source_checks: [],
      suggested_next_commands: [],
      discarded_or_low_confidence: [],
      is_authoritative: false,
      _meta: { ...fullMeta, chunking: { total_chunks: 1, analyzed_chunks: 1, omitted_chunks: 0, omitted: [], input_truncated: false, chunking_strategy: "none" } },
    });
  });
});

// ---------------------------------------------------------------------------
// 3. modelPathStatus / fallbackStatus edge cases
// ---------------------------------------------------------------------------

describe("modelPathStatus", () => {
  it("complete when all succeeded", () => {
    assert.strictEqual(modelPathStatus(true, false, false), "complete");
  });

  it("partial when input truncated", () => {
    assert.strictEqual(modelPathStatus(true, false, true), "partial");
  });

  it("partial when partial batch failure", () => {
    assert.strictEqual(modelPathStatus(true, true, false), "partial");
  });

  it("partial when both truncated and partial batch", () => {
    assert.strictEqual(modelPathStatus(true, true, true), "partial");
  });

  it("incomplete when model failed", () => {
    assert.strictEqual(modelPathStatus(false, false, false), "incomplete");
  });

  it("incomplete when model failed with truncation", () => {
    assert.strictEqual(modelPathStatus(false, false, true), "incomplete");
  });
});

describe("fallbackStatus", () => {
  it("complete when input is empty (nothing to analyze)", () => {
    assert.strictEqual(fallbackStatus("input_empty", false), "complete");
  });

  it("partial when heuristic found signals", () => {
    assert.strictEqual(fallbackStatus("model_not_configured", true), "partial");
  });

  it("partial when model not available but heuristic found signals", () => {
    assert.strictEqual(fallbackStatus("model_not_available", true), "partial");
  });

  it("incomplete when nothing found", () => {
    assert.strictEqual(fallbackStatus("model_not_configured", false), "incomplete");
  });

  it("incomplete when budget exceeded and no findings", () => {
    assert.strictEqual(fallbackStatus("budget_exceeded", false), "incomplete");
  });
});
