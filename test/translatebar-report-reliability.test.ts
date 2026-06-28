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

  it("GREEN: CommandOutputFindingSchema accepts kind=test_success", async () => {
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

  it("GREEN: CommandOutputFindingSchema accepts kind=build_success", async () => {
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

  it("GREEN: xcodebuild all-green fixture produces test_success finding with null first_failure", async () => {
    // Run the handler directly against the xcodebuild success fixture.
    // Per plan: on success, findings[0].kind === "test_success",
    // first_failure === null, primary_actionable_failure === null,
    // and detector_hint should NOT be "generic_log".
    const { handleCompressCommandOutput } = await import(
      "../src/tools/compress-command-output.js"
    );
    const { validateOutput } = await import("../src/schema.js");

    const fixturePath = join(FIXTURES_DIR, "command-output", "xcodebuild-success-136-tests.txt");
    const output = readFileSync(fixturePath, "utf-8");

    const result = await handleCompressCommandOutput(
      {
        command: "xcodebuild test",
        output,
        exit_code: 0,
        analysis_mode: "deterministic_only",
      },
      { workspaceRoot: TMP_DIR },
    );

    const data = JSON.parse(result.content[0].text as string);

    // Success findings should be present
    assert.ok(data.findings.length > 0, "Should have at least one finding");
    assert.equal(data.findings[0].kind, "test_success");

    // first_failure and primary_actionable_failure must be null on success
    assert.equal(data.first_failure, null);
    assert.equal(data.primary_actionable_failure, null);

    // Should NOT be generic_log
    assert.notEqual(data._meta.detector_hint, "generic_log");

    assert.match(data.summary, /success signal\(s\)/);
    assert.doesNotMatch(data.summary, /\berror\(s\)/);
    assert.ok(
      !data.suggested_next_commands.some((command: string) => /failing test/i.test(command)),
      "Success output should not suggest rerunning a failing test",
    );

    // Schema validation should pass
    const validated = validateOutput("aux_compress_command_output", data);
    assert.equal(validated.ok, true,
      `Output validation failed: ${!validated.ok ? validated.error : "OK"}`);
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

  it("RED: Fallback no longer extracts symbols (no misleading parameter counts)", async () => {
    const { summarizeFileFallback } = await import(
      "../src/fallback/summarize-file.js"
    );
    const result = summarizeFileFallback(
      TMP_DIR,
      "swift-service.swift",
    );
    // Fallback is purely mechanical — no parameter count issues to fix
    assert.equal(result.important_symbols.length, 0, "Fallback no longer extracts symbols");
    assert.ok(Array.isArray(result.heuristic_signals), "Should have heuristic_signals");
  });

  it("RED: Fallback provides mechanical signals for Swift files", async () => {
    const { summarizeFileFallback } = await import(
      "../src/fallback/summarize-file.js"
    );
    const result = summarizeFileFallback(
      TMP_DIR,
      "swift-service.swift",
    );
    assert.ok(result.heuristic_signals.some((s: any) => s.kind === "file_kind"), "Should detect file kind");
    assert.ok(result.heuristic_signals.some((s: any) => s.kind === "line_counts"), "Should count lines");
  });

  it("RED: non-TS/JS fallback marks analysis_status as incomplete", async () => {
    const { handleSummarizeFile } = await import(
      "../src/tools/summarize-file.js"
    );
    const output = await handleSummarizeFile(
      { path: "swift-service.swift" },
      { workspaceRoot: TMP_DIR },
    );
    const data = JSON.parse(output.content[0].text as string);

    // Fallback now returns "incomplete" for all files — no semantic analysis
    assert.equal(data.analysis_status, "incomplete");
    assert.equal(data._meta.fallback_used, true);
    assert.equal(data.important_symbols.length, 0, "No symbol extraction");
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
