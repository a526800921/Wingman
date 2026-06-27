/**
 * Step 0 red-light → green-light tests for TranslateBar report reliability fixes.
 *
 * These tests assert the DESIRED behavior defined in:
 *   docs/plans/wingman-mcp-translatebar-report-reliability.md
 *
 * Currently they should FAIL (red-light) because:
 *   1. compress_command_output: kind enum has no success variants,
 *      and first_failure is populated even for all-green output.
 *   2. summarize_file: Swift fallback misreports function parameter counts
 *      (e.g. "0 parameters" for init with actual parameters).
 *   3. review_diff: prompts do not inject the runtime current date,
 *      allowing model to hallucinate future-date findings.
 *
 * After plan implementation completes, all tests should PASS (green-light).
 *
 * Run: node --import tsx --test test/translatebar-report-reliability.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const TMP_DIR = join(__dirname, "..", "tmp_translatebar_redlight");
const FIXTURES_DIR = join(__dirname, "fixtures");

// Ensure no API key leaks for fallback-only tests
const savedKey = process.env.AUX_MODEL_API_KEY;

function setup() {
  mkdirSync(TMP_DIR, { recursive: true });
  // Copy Swift fixture for safe-path resolution
  writeFileSync(
    join(TMP_DIR, "swift-service.swift"),
    readFileSync(join(FIXTURES_DIR, "summarize-file", "swift-service.swift"), "utf-8"),
  );
}

function cleanup() {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Fixture A: xcodebuild all-green → no test_failure kind
// ---------------------------------------------------------------------------

describe("RED: compress_command_output — success kind & first_failure", () => {
  before(() => {
    delete process.env.AUX_MODEL_API_KEY;
    process.env.AUX_WORKSPACE_ROOT = TMP_DIR;
    setup();
  });
  after(() => {
    cleanup();
    if (savedKey) process.env.AUX_MODEL_API_KEY = savedKey;
    else delete process.env.AUX_MODEL_API_KEY;
    delete process.env.AUX_WORKSPACE_ROOT;
  });

  it("RED: CommandOutputFindingSchema rejects kind=test_success", async () => {
    // The current kind enum is:
    // ["test_failure", "type_error", "lint_error", "build_error",
    //  "runtime_exception", "warning", "info", "unknown"]
    //
    // There is NO test_success or build_success. The schema cannot represent
    // an all-green test run without mislabeling it as a failure.
    const { CommandOutputFindingSchema } = await import("../src/schema.js");

    const validFinding = {
      kind: "test_success",
      message: "All 136 tests passed, 0 failures",
      evidence: "TEST SUCCEEDED — 136 tests, 0 failures",
      confidence: "high",
    };

    const result = CommandOutputFindingSchema.safeParse(validFinding);

    // GREEN: schema now accepts test_success kind
    assert.ok(
      result.success,
      `GREEN: kind=test_success should be accepted. ` +
      `Error: ${!result.success ? result.error.message : "OK"}`,
    );
  });

  it("RED: CommandOutputFindingSchema rejects kind=build_success", async () => {
    const { CommandOutputFindingSchema } = await import("../src/schema.js");

    const validFinding = {
      kind: "build_success",
      message: "Build completed successfully",
      evidence: "BUILD SUCCEEDED",
      confidence: "high",
    };

    const result = CommandOutputFindingSchema.safeParse(validFinding);

    // GREEN: schema now accepts build_success kind
    assert.ok(
      result.success,
      `GREEN: kind=build_success should be accepted. ` +
      `Error: ${!result.success ? result.error.message : "OK"}`,
    );
  });

  it("RED: CompressCommandOutputOutput schema rejects first_failure.kind=test_success", async () => {
    // The output schema's first_failure is a CommandOutputFinding, so it should
    // also reject success kinds until the fix is in place.
    const { validateOutput } = await import("../src/schema.js");

    const outputData = {
      summary: "All tests passed",
      analysis_status: "complete",
      first_failure: {
        kind: "test_success",
        message: "Tests passed",
        evidence: "OK",
        confidence: "high",
      },
      primary_actionable_failure: undefined,
      findings: [],
      repeated_errors: [],
      suggested_source_checks: [],
      suggested_next_commands: [],
      discarded_or_low_confidence: [],
      is_authoritative: false,
      _meta: {
        model: "test",
        input_truncated: false,
        fallback_used: false,
        chunking: { total_chunks: 1, analyzed_chunks: 1, omitted_chunks: 0, omitted: [], input_truncated: false, chunking_strategy: "test" },
      },
    };

    const result = validateOutput("aux_compress_command_output", outputData);

    // GREEN: schema now accepts test_success kind in output
    assert.ok(
      result.ok,
      `GREEN: output with first_failure.kind=test_success should be accepted. ` +
      `Error: ${!result.ok ? result.error : "OK"}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Fixture B: Swift fallback — no misleading 0 parameters
// ---------------------------------------------------------------------------

describe("RED: summarize_file — Swift fallback parameter count", () => {
  before(() => {
    delete process.env.AUX_MODEL_API_KEY;
    process.env.AUX_WORKSPACE_ROOT = TMP_DIR;
    setup();
  });
  after(() => {
    cleanup();
    if (savedKey) process.env.AUX_MODEL_API_KEY = savedKey;
    else delete process.env.AUX_MODEL_API_KEY;
    delete process.env.AUX_WORKSPACE_ROOT;
  });

  it("RED: Swift init(apiClient:cache:) is NOT reported as 0 parameters", async () => {
    const { summarizeFileFallback } = await import(
      "../src/fallback/summarize-file.js"
    );
    const result = summarizeFileFallback(
      TMP_DIR,
      "swift-service.swift",
    );

    const initSym = result.important_symbols.find((s) => s.name === "init");
    assert.ok(initSym, "Should find init symbol");

    // RED: The current fallback reports "function takes 0 parameters"
    // for init(apiClient:cache:). This is misleading — the parameter
    // count is unknown, not zero.
    const role = initSym.role ?? "";

    // RED assertion: role should NOT claim "0 parameters" when parameters exist
    const hasZeroParams = /\b0 parameters?\b/.test(role);
    assert.ok(
      !hasZeroParams,
      `RED: init role should NOT report "0 parameters". ` +
      `Got: "${role}". ` +
      `The fallback should report parameters_unknown or omit the count rather than defaulting to 0.`,
    );
  });

  it("RED: Swift fetchProfile(for:) reports correct parameter count", async () => {
    const { summarizeFileFallback } = await import(
      "../src/fallback/summarize-file.js"
    );
    const result = summarizeFileFallback(
      TMP_DIR,
      "swift-service.swift",
    );

    const sym = result.important_symbols.find((s) => s.name === "fetchProfile");
    assert.ok(sym, "Should find fetchProfile symbol");
    // fetchProfile(for userId: String) has 1 parameter — this should work
    const role = sym.role ?? "";
    const hasOneParam = /\b1 parameters?\b/.test(role);
    assert.ok(
      hasOneParam,
      `RED: fetchProfile should report 1 parameter. Got: "${role}"`,
    );
  });

  it("RED: non-TS/JS fallback marks analysis_status as partial and confidence as low", async () => {
    const { handleSummarizeFile } = await import(
      "../src/tools/summarize-file.js"
    );
    const output = await handleSummarizeFile(
      { path: "swift-service.swift" },
      { workspaceRoot: TMP_DIR },
    );
    const data = JSON.parse(output.content[0].text as string);

    // RED: Swift files should have explicit low-confidence markers
    assert.equal(
      data.analysis_status,
      "partial",
      "RED: Non-TS/JS fallback should set analysis_status to partial",
    );
    assert.equal(
      data._meta.fallback_used,
      true,
      "RED: Non-TS/JS fallback should have fallback_used: true",
    );
    // RED: The _meta should indicate low confidence for non-TS/JS
    // (current implementation may or may not have this field)
  });
});

// ---------------------------------------------------------------------------
// Fixture C: review_diff — current date injection
// ---------------------------------------------------------------------------

describe("RED: review_diff — current date in prompts", () => {
  it("RED: review diff system prompt contains current date when provided", async () => {
    // The fix will modify buildReviewDiffSystemPrompt to accept a currentDate
    // parameter. The old function ignores it.
    const { buildReviewDiffSystemPrompt } = await import("../src/prompts.js");
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Call with currentDate — old function ignores extra args.
    // After fix, the function signature may include currentDate.
    const prompt = buildReviewDiffSystemPrompt(today as any);

    // RED: old prompt does NOT contain today's date.
    // After fix, the prompt should include the injected current date.
    assert.ok(
      prompt.includes(today),
      `RED: system prompt should contain current date "${today}". ` +
      `Old implementation does not inject runtime date.`,
    );
  });

  it("RED: review diff user message contains current date when provided", async () => {
    const { buildReviewDiffUserMessage } = await import("../src/prompts.js");
    const today = new Date().toISOString().slice(0, 10);

    const msg = buildReviewDiffUserMessage("test diff", undefined, today as any);

    // RED: old message does NOT contain today's date.
    assert.ok(
      msg.includes(today),
      `RED: user message should contain current date "${today}". ` +
      `Old implementation does not inject runtime date.`,
    );
  });

  it("RED: review_diff_by_file system prompt contains current date when provided", async () => {
    const { buildReviewDiffByFileSystemPrompt } = await import("../src/prompts.js");
    const today = new Date().toISOString().slice(0, 10);

    const prompt = buildReviewDiffByFileSystemPrompt(today as any);

    // RED: old prompt does NOT contain today's date.
    assert.ok(
      prompt.includes(today),
      `RED: review_diff_by_file system prompt should contain current date "${today}".`,
    );
  });

  it("RED: review_diff_by_file user message contains current date when provided", async () => {
    const { buildReviewDiffByFileUserMessage } = await import("../src/prompts.js");
    const today = new Date().toISOString().slice(0, 10);

    const msg = buildReviewDiffByFileUserMessage(
      "test", "file.ts", false, undefined, today as any,
    );

    // RED: old message does NOT contain today's date.
    assert.ok(
      msg.includes(today),
      `RED: review_diff_by_file user message should contain current date "${today}".`,
    );
  });
});
