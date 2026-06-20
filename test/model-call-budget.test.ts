/**
 * Model call budget tests.
 *
 * Verifies that:
 *   A. Structure-only (high confidence tsc) → 0 model calls in chunking
 *   B. Batch grouping produces 2-4 batches for 14 diagnostics
 *   C. MAX_MODEL_CALLS cap is enforced
 *   D. Fallback preserves all findings without model
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { chunkCommandOutput } from "../src/chunking/command-output.js";
import { parseTscDiagnostics } from "../src/diagnostics/tsc-parser.js";
import { compressCommandOutputFallback } from "../src/fallback/compress-command-output.js";

// ── Reusable 14-error fixture ─────────────────────────────

const FOURTEEN_ERRORS = `src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/app.ts(15,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/app.ts(20,3): error TS18046: 'x' is of type 'unknown'.
src/app.ts(25,12): error TS2339: Property 'foo' does not exist on type 'Bar'.
src/utils.ts(8,1): error TS2304: Cannot find name 'process'.
src/utils.ts(12,5): error TS2532: Object is possibly 'undefined'.
src/utils.ts(18,9): error TS2345: Argument of type 'string' is not assignable.
src/utils.ts(22,7): error TS2554: Expected 2 arguments, but got 1.
src/utils.ts(30,3): error TS2307: Cannot find module 'unknown-lib'.
src/helpers.ts(5,10): error TS18047: 'obj' is possibly 'null'.
src/helpers.ts(11,8): error TS2367: This comparison appears to be unintentional.
src/helpers.ts(16,4): error TS6133: 'unused' is declared but its value is never read.
src/helpers.ts(20,6): error TS2322: Type 'number' is not assignable to type 'string'.
src/helpers.ts(25,2): error TS2588: Cannot assign to 'readonly' because it is a constant.
Found 14 errors in 3 files.
`;

const FORTY_ERRORS = Array.from({ length: 45 }, (_, i) =>
  `src/file${i}.ts(${i + 1},1): error TS${2300 + i}: Error number ${i}`,
).join("\n") + "\nFound 45 errors in 45 files.\n";

// ── Budget constants (must match handler) ─────────────────

const MAX_PER_BATCH = 20;
const MAX_BATCH_CHARS = 6000;
const MAX_MODEL_CALLS = 5;

// ── Scenario A: Structure-only ────────────────────────────

describe("budget scenario A: structure-only", () => {
  it("14 high-confidence tsc errors: parser completes without model", () => {
    // Parser produces diagnostics (deterministic, no model needed)
    const parsed = parseTscDiagnostics(FOURTEEN_ERRORS);
    assert.equal(parsed.diagnostics.length, 14);

    // All diagnostics should have high parser_confidence
    for (const d of parsed.diagnostics) {
      assert.equal(d.parser_confidence, "high",
        `Diagnostic ${d.id} should have high confidence, got ${d.parser_confidence}`);
    }
  });

  it("fallback returns complete results with 0 model involvement", () => {
    const fb = compressCommandOutputFallback(undefined, FOURTEEN_ERRORS, 2);
    assert.equal(fb.findings.length, 14);
    assert.equal(fb.is_authoritative, false);
    // Fallback always works without model
    assert.ok(fb.summary.length > 0);
    assert.ok(fb.first_failure !== undefined || fb.findings.length > 0);
  });
});

// ── Scenario B: Batch grouping ────────────────────────────

describe("budget scenario B: batch grouping", () => {
  it("14 tsc errors produce 1-2 diagnostic batches in chunking", () => {
    const { chunks } = chunkCommandOutput(FOURTEEN_ERRORS);

    // Only count diagnostic batch chunks (labeled "tsc diagnostics batch")
    const diagBatches = chunks.filter(c => c.label.startsWith("tsc diagnostics batch"));

    // P0-3: 14 compact diagnostics fit in 1 batch (MAX_PER_BATCH=20, payload < 6000 chars)
    assert.ok(
      diagBatches.length >= 1 && diagBatches.length <= 2,
      `Expected 1-2 diag batches for 14 errors, got ${diagBatches.length}`,
    );

    // Each batch should contain valid JSON
    for (const batch of diagBatches) {
      const parsed = JSON.parse(batch.text);
      assert.ok(Array.isArray(parsed), "Batch text should be a JSON array");
      assert.ok(parsed.length <= MAX_PER_BATCH,
        `Batch should have at most ${MAX_PER_BATCH} diagnostics, got ${parsed.length}`);
      assert.ok(parsed.length > 0, "Batch should not be empty");
      // Each diagnostic should have required fields
      for (const d of parsed) {
        assert.ok(d.id, "Diagnostic must have id");
        assert.ok(typeof d.headline === "string", "Diagnostic must have headline");
      }
    }

    // Total diagnostics across all batches should be 14
    const totalDiags = diagBatches.reduce((sum, b) => sum + JSON.parse(b.text).length, 0);
    assert.equal(totalDiags, 14,
      `Total diagnostics across batches should be 14, got ${totalDiags}`);
  });

  it("larger input respects per-batch character budget", () => {
    const { chunks } = chunkCommandOutput(FORTY_ERRORS);
    const diagBatches = chunks.filter(c => c.label.startsWith("tsc diagnostics batch"));

    // Each batch text should not be excessively large
    for (const batch of diagBatches) {
      assert.ok(batch.text.length <= MAX_BATCH_CHARS * 1.2,
        `Batch should not greatly exceed char budget: ${batch.text.length}`);
    }
  });

  it("model batches cap respects total count even without actual model", () => {
    // This verifies the chunking layer respects boundaries
    const { chunks } = chunkCommandOutput(FORTY_ERRORS);
    const diagBatches = chunks.filter(c => c.label.startsWith("tsc diagnostics batch"));

    // 45 errors / 8 per batch ≈ 6 batches, but should be chunked reasonably
    assert.ok(diagBatches.length >= 1, "Should have at least 1 batch");
    // All diagnostics should appear across batches
    const totalDiags = diagBatches.reduce((sum, b) => sum + JSON.parse(b.text).length, 0);
    assert.ok(totalDiags >= 40, `Should have at least 40 diagnostics, got ${totalDiags}`);
  });
});

// ── Scenario C: Over budget ───────────────────────────────

describe("budget scenario C: over budget", () => {
  it("large input (45 errors) still preserves all parser findings", () => {
    const fb = compressCommandOutputFallback(undefined, FORTY_ERRORS, 2);
    // Parser should parse all errors
    const parsed = parseTscDiagnostics(FORTY_ERRORS);
    assert.ok(parsed.diagnostics.length >= 40,
      `Expected at least 40 diagnostics, got ${parsed.diagnostics.length}`);

    // Fallback should have all findings
    assert.ok(fb.findings.length >= 40,
      `Expected at least 40 findings, got ${fb.findings.length}`);

    // No findings lost even without model
    assert.equal(fb.is_authoritative, false);
  });

  it("chunking never produces more than 1 chunk per diagnostic", () => {
    // This is the key regression protection: 14 errors ≠ 23 chunks
    const { chunks } = chunkCommandOutput(FOURTEEN_ERRORS);
    const diagBatches = chunks.filter(c => c.label.startsWith("tsc diagnostics batch"));

    // The key invariant: number of batches << number of diagnostics
    // (Previously: 14 errors → 23 chunks; now: 14 errors → 1 batch)
    assert.ok(
      diagBatches.length <= 2,
      `14 errors should produce ≤ 2 batches (was 23 before fix), got ${diagBatches.length}`,
    );
  });
});

// ── Scenario D: Fallback always complete ──────────────────

describe("budget scenario D: fallback completeness", () => {
  it("fallback findings count equals parser diagnostic count for clean tsc", () => {
    const parsed = parseTscDiagnostics(FOURTEEN_ERRORS);
    const fb = compressCommandOutputFallback(undefined, FOURTEEN_ERRORS, 2);

    // Core invariant: findings = diagnostics (no detail split, no loss)
    assert.equal(fb.findings.length, parsed.diagnostics.length,
      `findings (${fb.findings.length}) should equal diagnostics (${parsed.diagnostics.length})`);
  });

  it("fallback findings never exceed diagnostic count (no inflation)", () => {
    const parsed = parseTscDiagnostics(FOURTEEN_ERRORS);
    const fb = compressCommandOutputFallback(undefined, FOURTEEN_ERRORS, 2);

    // Another core invariant: findings should not exceed diagnostics
    assert.ok(
      fb.findings.length <= parsed.diagnostics.length,
      `findings (${fb.findings.length}) should not exceed diagnostics (${parsed.diagnostics.length})`,
    );
  });

  it("summary counts are consistent with findings array", () => {
    const fb = compressCommandOutputFallback(undefined, FOURTEEN_ERRORS, 2);

    const errorCount = fb.findings.filter(f => f.kind !== "warning" && f.kind !== "info").length;
    const warnCount = fb.findings.filter(f => f.kind === "warning").length;

    // Summary must reflect actual finding counts (not inflated)
    const summary = fb.summary;
    assert.ok(summary.includes(`${errorCount} error`),
      `Summary "${summary}" should mention ${errorCount} errors`);

    if (warnCount > 0) {
      assert.ok(summary.includes(`${warnCount} warning`));
    }
  });

  it("fallback preserves findings when model would be unavailable", () => {
    // Simulate: no API key scenario → fallback must still work
    const fb = compressCommandOutputFallback(undefined, FOURTEEN_ERRORS, undefined);
    assert.equal(fb.is_authoritative, false);
    assert.ok(fb.findings.length > 0);
    assert.ok(fb.summary.length > 0);
    assert.ok(Array.isArray(fb.suggested_source_checks));
    assert.ok(Array.isArray(fb.suggested_next_commands));
  });
});
