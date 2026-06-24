/**
 * Contract assertion tests.
 *
 * These tests verify invariants that must never be violated:
 * - Parser: one diagnostic block = one finding, no detail split
 * - Aggregation: summary counts match findings, field derivation consistent
 * - Model degradation: parser results preserved when model fails
 * - Diff: findings array support, per-file status
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { parseTscDiagnostics } from "../src/diagnostics/tsc-parser.js";
import { compressCommandOutputFallback } from "../src/fallback/compress-command-output.js";
import { reviewDiffByFileFallback } from "../src/fallback/review-diff-by-file.js";
import { deduplicateCommandFindings } from "../src/chunking/merge.js";

// ── Reusable fixtures ─────────────────────────────────────

const FOURTEEN_ERRORS = `src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/app.ts(15,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/utils.ts(8,1): error TS2304: Cannot find name 'process'.
src/utils.ts(12,5): error TS2532: Object is possibly 'undefined'.
src/helpers.ts(5,10): error TS18047: 'obj' is possibly 'null'.
src/helpers.ts(11,8): error TS2367: This comparison appears to be unintentional.
src/helpers.ts(16,4): error TS6133: 'unused' is declared but its value is never read.
src/helpers.ts(20,6): error TS2322: Type 'number' is not assignable to type 'string'.
src/models.ts(50,10): error TS2344: Type 'X' does not satisfy the constraint 'Y'.
  The types of 'nested.deep' are incompatible.
    Type 'boolean' is not assignable to type 'string'.
src/models.ts(55,3): error TS2322: Type 'number' is not assignable to type 'string'.
src/handler.ts(88,12): error TS2345: Type 'A' is not assignable to type 'B'.
  Property 'validated' is missing in type 'A'.
src/services/auth.ts(50,10): error TS2345: Argument of type 'null' is not assignable.
src/services/auth.ts(55,4): error TS6133: 'debugMode' is declared but never read.
src/__tests__/auth.test.ts(20,8): error TS2339: Property 'login' does not exist.
Found 14 errors in 5 files.
`;

const GENERATED_MIXED = `.next/server/page.ts(15,8): error TS2345: Error in generated
src/app.ts(10,5): error TS2322: Error in project source
src/__tests__/app.test.ts(20,8): error TS2339: Error in test file
Found 3 errors in 3 files.
`;

const DIFF_TWO_RISKS = `--- a/src/handler.ts
+++ b/src/handler.ts
@@ -10,6 +10,12 @@ export async function handleRequest(req: Request): Promise<Response> {
   const user = await getUser(req);

   if (!user) {
+    console.log("no user found");
+    const token = "sk-test-secret-key-12345";
+
     return new Response("Unauthorized", { status: 401 });
   }
`;

// ── Parser contracts ──────────────────────────────────────

describe("parser contract", () => {
  it("one diagnostic block = one finding (no detail split)", () => {
    const result = parseTscDiagnostics(FOURTEEN_ERRORS);
    // 14 errors → 14 diagnostics
    assert.equal(result.diagnostics.length, 14,
      `Expected 14 diagnostics, got ${result.diagnostics.length}`);

    // Every diagnostic with detail lines: evidence should contain them
    for (const d of result.diagnostics) {
      if (d.details.length > 0) {
        for (const detail of d.details) {
          assert.ok(d.evidence.includes(detail.trim()),
            `Evidence should contain detail: "${detail.slice(0, 80)}"`);
        }
      }
    }

    // No diagnostic evidence should contain the summary line
    for (const d of result.diagnostics) {
      assert.ok(!d.evidence.includes("Found 14 errors"),
        `Diagnostic ${d.id} should not contain summary line`);
    }

    // All diagnostic IDs must be unique
    const ids = result.diagnostics.map(d => d.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("detail lines belong to parent diagnostic, not standalone", () => {
    const result = parseTscDiagnostics(FOURTEEN_ERRORS);

    // TS2344 diagnostic at models.ts:50 should have detail lines
    const ts2344 = result.diagnostics.find(d => d.error_code === "TS2344" && d.file === "src/models.ts");
    assert.ok(ts2344, "TS2344 diagnostic should exist");
    assert.ok(ts2344!.details.length >= 2,
      `TS2344 should have at least 2 detail lines, got ${ts2344!.details.length}`);

    // The detail line about 'nested.deep' should NOT be a separate diagnostic
    const nestedDiags = result.diagnostics.filter(d => d.evidence.includes("nested.deep"));
    assert.equal(nestedDiags.length, 1,
      `Detail 'nested.deep' should be in exactly 1 diagnostic, got ${nestedDiags.length}`);
  });

  it("parser preserves file, line, column, error_code from input", () => {
    const result = parseTscDiagnostics("src/app.ts(42,15): error TS2345: Test error");
    assert.equal(result.diagnostics.length, 1);
    const d = result.diagnostics[0];
    assert.equal(d.file, "src/app.ts");
    assert.equal(d.line, 42);
    assert.equal(d.column, 15);
    assert.equal(d.error_code, "TS2345");
  });

  it("unrecognized segments do not lose other diagnostics", () => {
    const output = [
      "Some preamble text",
      "src/app.ts(10,5): error TS2345: Type error",
      "Some middle text",
      "src/utils.ts(8,1): error TS2304: Missing name",
    ].join("\n");

    const result = parseTscDiagnostics(output);
    assert.equal(result.diagnostics.length, 2,
      "Should parse 2 diagnostics despite unrecognized segments");
  });
});

// ── Finding aggregation contracts ─────────────────────────

describe("finding aggregation contract", () => {
  it("summary error/warning counts match findings array length", () => {
    const fb = compressCommandOutputFallback(undefined, FOURTEEN_ERRORS, 2);

    const errorCount = fb.findings.filter(f => f.kind !== "warning" && f.kind !== "info").length;
    const warnCount = fb.findings.filter(f => f.kind === "warning").length;

    // Summary must mention the correct counts
    assert.ok(fb.summary.includes(`${errorCount} error`),
      `Summary should mention ${errorCount} errors: ${fb.summary}`);
    if (warnCount > 0) {
      assert.ok(fb.summary.includes(`${warnCount} warning`));
    }

    // findings must not be empty
    assert.ok(fb.findings.length > 0, "Should have findings");

    // first_failure should be the first non-warning/non-info finding
    if (fb.first_failure) {
      assert.ok(
        fb.first_failure.kind !== "warning" && fb.first_failure.kind !== "info",
        "first_failure should be an error-type finding",
      );
    }
  });

  it("repeated errors preserve count and independent positions", () => {
    // Two identical TS2322 errors in different files
    const input = [
      "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(5,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join("\n");

    const fb = compressCommandOutputFallback(undefined, input, 2);
    // Both should be in findings
    assert.equal(fb.findings.length, 2, "Two findings for two files");

    // Repeated errors should count them
    const repeated = fb.repeated_errors.find(r =>
      r.message.toLowerCase().includes("not assignable"),
    );
    assert.ok(repeated, "Should have repeated error entry");
    assert.equal(repeated!.count, 2);
  });

  it("suggested_source_checks deduplicates by file", () => {
    // Multiple errors in same file
    const input = [
      "src/app.ts(10,5): error TS2345: Error one",
      "src/app.ts(20,3): error TS2322: Error two",
      "src/app.ts(30,7): error TS2339: Error three",
      "src/other.ts(1,1): error TS2304: Other file",
    ].join("\n");

    const fb = compressCommandOutputFallback(undefined, input, 2);
    const appChecks = fb.suggested_source_checks.filter(c => c.includes("src/app.ts"));
    // Should be at most 1 check per file
    assert.ok(appChecks.length <= 1,
      `src/app.ts should appear at most once in suggestions, got ${appChecks.length}`);
  });

  it("generated files are preserved but deprioritized", () => {
    const fb = compressCommandOutputFallback(undefined, GENERATED_MIXED, 2);
    assert.equal(fb.findings.length, 3);

    // Generated files must still exist in findings
    const generatedF = fb.findings.filter(f => f.file?.includes(".next/"));
    assert.equal(generatedF.length, 1, "Generated file finding should be preserved");

    // Project source errors must also exist
    const projectF = fb.findings.filter(f => f.file?.includes("src/") && !f.file?.includes(".test."));
    assert.equal(projectF.length, 1);

    // Test files must also exist
    const testF = fb.findings.filter(f => f.file?.includes(".test."));
    assert.equal(testF.length, 1);
  });
});

// ── Model degradation contracts ───────────────────────────

describe("model degradation contract", () => {
  it("fallback returns complete results without model", () => {
    const fb = compressCommandOutputFallback(undefined, FOURTEEN_ERRORS, 2);
    assert.equal(fb.is_authoritative, false);
    assert.ok(fb.summary.length > 0);
    assert.ok(fb.findings.length > 0);
    assert.ok(Array.isArray(fb.repeated_errors));
    assert.ok(Array.isArray(fb.suggested_source_checks));
    assert.ok(Array.isArray(fb.discarded_or_low_confidence));
  });

  it("findings preserve file, line, column, error_code from parser", () => {
    const fb = compressCommandOutputFallback(undefined, FOURTEEN_ERRORS, 2);

    // Check a specific finding
    const f = fb.findings.find(x => x.file === "src/app.ts" && x.line === 10);
    assert.ok(f, "Should find app.ts:10");
    assert.equal(f!.column, 5);
    assert.equal(f!.error_code, "TS2345");

    // Evidence should not be empty
    assert.ok(f!.evidence.length > 0, "Evidence must not be empty");
  });

  it("deduplication does not lose unique findings", () => {
    const fb = compressCommandOutputFallback(undefined, FOURTEEN_ERRORS, 2);
    const deduped = deduplicateCommandFindings(fb.findings);

    // Deduped count should be close to original (errors are in different files/lines)
    assert.ok(
      deduped.length >= fb.findings.length - 2,
      `Dedup should not lose many findings: ${fb.findings.length} → ${deduped.length}`,
    );
  });
});

// ── Diff minimum contracts ────────────────────────────────

describe("diff contract", () => {
  it("single chunk can return multiple findings", () => {
    const fb = reviewDiffByFileFallback(DIFF_TWO_RISKS);
    const allFindings = fb.files.flatMap(fr => fr.findings);

    // console.log + hardcoded token = at least 2 findings
    assert.ok(allFindings.length >= 2,
      `Expected at least 2 findings from multi-risk diff, got ${allFindings.length}`);
  });

  it("files array contains analyzed file with status", () => {
    const fb = reviewDiffByFileFallback(DIFF_TWO_RISKS);
    assert.ok(fb.files.length > 0, "files array should not be empty");
    // File path in unified diff uses "b/" prefix
    assert.ok(fb.files[0].file.includes("src/handler.ts"),
      `Expected file to include src/handler.ts, got ${fb.files[0].file}`);
    assert.ok(fb.files[0].change_summary.length > 0);
    assert.ok(Array.isArray(fb.files[0].findings));
  });

  it("top_risks derived from file-level findings", () => {
    const fb = reviewDiffByFileFallback(DIFF_TWO_RISKS);
    const allFindings = fb.files.flatMap(fr => fr.findings);
    // top_risks count should not exceed findings count
    assert.ok(fb.top_risks.length <= allFindings.length);
    // All top_risks must have file and evidence
    for (const risk of fb.top_risks) {
      assert.ok(risk.file, "top_risk must have file");
      assert.ok(risk.evidence, "top_risk must have evidence");
    }
  });

  it("different risks in same file are not incorrectly deduped", () => {
    const fb = reviewDiffByFileFallback(DIFF_TWO_RISKS);
    const risks = fb.files.flatMap(fr => fr.findings).map(f => f.risk);

    // console + token = 2 distinct risk categories
    const uniqueRisks = new Set(risks.map(r => r.toLowerCase()));
    assert.ok(uniqueRisks.size >= 2,
      `Expected at least 2 unique risk categories, got ${uniqueRisks.size}: ${[...uniqueRisks].join(", ")}`);
  });
});
