/**
 * Fixture replay tests — verify parser/fallback produce correct results
 * for real-world inputs stored as anonymous fixtures.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { reviewDiffByFileFallback } from "../src/fallback/review-diff-by-file.js";
import {
  readFixture,
  readExpectation,
  replayCommandOutput,
  replayDiff,
  assertIncludesCodes,
  assertIncludesFiles,
  assertNotIncludesEvidence,
  assertIncludesRisks,
} from "./helpers/fixture-runner.js";
import type { CommandOutputExpectation, DiffExpectation } from "./helpers/fixture-runner.js";

// ── Command output fixtures ──────────────────────────────

describe("fixture replay: command output", () => {
  it("tsc-real-14-errors: 14 errors → 14 diagnostics, no detail split", () => {
    const exp = readExpectation<CommandOutputExpectation>("expectations/tsc-real-14-errors.json");
    const result = replayCommandOutput(exp.fixture);

    // Parser contract: diagnostic count matches expectation
    assert.equal(
      result.diagnostics.length,
      exp.expected.diagnostics_parsed,
      `Expected ${exp.expected.diagnostics_parsed} diagnostics, got ${result.diagnostics.length}`,
    );

    // Each diagnostic must have a unique id
    const ids = new Set(result.diagnostics.map(d => d.id));
    assert.equal(ids.size, result.diagnostics.length, "All diagnostic IDs must be unique");

    // Each diagnostic must have file, line, column, error_code where applicable
    for (const d of result.diagnostics) {
      assert.ok(d.id, "Diagnostic must have id");
      assert.ok(d.headline, "Diagnostic must have headline");
      assert.ok(d.evidence.length > 0, "Diagnostic must have evidence");
    }

    // P0-1: All 7 TS2344 diagnostics have different line numbers
    const ts2344Diags = result.diagnostics.filter(d => d.error_code === "TS2344");
    assert.equal(ts2344Diags.length, 7, "Expected 7 TS2344 diagnostics");
    const ts2344Lines = new Set(ts2344Diags.map(d => d.line));
    assert.equal(ts2344Lines.size, 7, "All 7 TS2344 should have different lines");

    // Fallback contract: finding count matches (P0-2: 14 retained)
    assert.equal(
      result.fallback.findings.length,
      exp.expected.findings_retained,
      `Expected ${exp.expected.findings_retained} findings, got ${result.fallback.findings.length}`,
    );

    // P0-1: All findings have _diagnostic_id
    for (const f of result.fallback.findings) {
      assert.ok(f._diagnostic_id, `Finding should have _diagnostic_id`);
    }

    // Required error codes present
    assertIncludesCodes(result.fallback.findings, exp.expected.must_include_codes!, "tsc-real-14-errors");

    // All required locations present (file:line)
    for (const loc of exp.expected.must_include_locations!) {
      const [file, lineStr] = loc.split(":");
      const line = Number(lineStr);
      const found = result.fallback.findings.some(f => f.file === file && f.line === line);
      assert.ok(found, `[tsc-real-14-errors] Expected finding at ${loc} but not found`);
    }

    // Summary line must NOT be in evidence
    assertNotIncludesEvidence(result.fallback.findings, exp.expected.must_not_include_evidence!, "tsc-real-14-errors");

    // P0-4: Summary should mention error count
    const summary = result.fallback.summary;
    assert.ok(summary.includes("14 error"), `Summary should mention error count: ${summary}`);
  });

  it("tsc-multiline-ts2344: detail lines belong to parent diagnostic", () => {
    const exp = readExpectation<CommandOutputExpectation>("expectations/tsc-multiline-ts2344.json");
    const result = replayCommandOutput(exp.fixture);

    // 4 errors → 4 diagnostics (not more)
    assert.equal(result.diagnostics.length, exp.expected.diagnostics_parsed,
      `Expected ${exp.expected.diagnostics_parsed} diagnostics, got ${result.diagnostics.length}`);

    // The TS2344 diagnostics should have detail lines
    const ts2344Diags = result.diagnostics.filter(d => d.error_code === "TS2344");
    assert.ok(ts2344Diags.length >= 1, "Expected at least 1 TS2344 diagnostic");

    for (const d of ts2344Diags) {
      assert.ok(d.details.length >= 1,
        `TS2344 diagnostic at ${d.file}:${d.line} should have detail lines, got ${d.details.length}`);
      // Evidence should include all detail lines
      for (const detail of d.details) {
        assert.ok(d.evidence.includes(detail.trim()),
          "Evidence should contain all detail lines");
      }
    }

    // Contract: findings = diagnostics
    assert.equal(result.fallback.findings.length, exp.expected.findings_retained);

    // No summary in evidence
    assertNotIncludesEvidence(
      result.fallback.findings,
      exp.expected.must_not_include_evidence!,
      "tsc-multiline-ts2344",
    );
  });

  it("tsc-generated-and-source: project files prioritized over generated", () => {
    const exp = readExpectation<CommandOutputExpectation>("expectations/tsc-generated-and-source.json");
    const result = replayCommandOutput(exp.fixture);

    // 10 errors → 10 diagnostics
    assert.equal(result.diagnostics.length, exp.expected.diagnostics_parsed);
    assert.equal(result.fallback.findings.length, exp.expected.findings_retained);

    // Count generated findings
    const generatedFindings = result.fallback.findings.filter(f =>
      f.file?.includes(".next/") || f.file?.includes("dist/"),
    );
    assert.equal(
      generatedFindings.length,
      exp.expected.generated_findings,
      `Expected ${exp.expected.generated_findings} generated findings, got ${generatedFindings.length}`,
    );

    // Project source files should appear in suggested_source_checks before generated ones
    const checks = result.fallback.suggested_source_checks;
    // First check should be a project source file, not .next or dist
    const firstThree = checks.slice(0, 3).join(" ");
    const hasProjectFirst = checks.some(c => c.includes("src/"));
    assert.ok(hasProjectFirst, "Project source files should appear in suggestions");

    // generated files should still be in findings (not deleted)
    assert.ok(generatedFindings.length > 0, "Generated files should be preserved in findings");

    // No summary in evidence
    assertNotIncludesEvidence(result.fallback.findings, exp.expected.must_not_include_evidence!, "tsc-generated-and-source");
  });
});

// ── Diff fixture ──────────────────────────────────────────

describe("fixture replay: diff", () => {
  it("multi-risk-single-hunk: two risks in one hunk both found", () => {
    const exp = readExpectation<DiffExpectation>("expectations/multi-risk-single-hunk.json");
    const result = replayDiff(exp.fixture);

    // At least min_findings total across all files
    const allFindings = result.files.flatMap(fr => fr.findings);
    assert.ok(
      allFindings.length >= exp.expected.min_findings!,
      `Expected at least ${exp.expected.min_findings} findings, got ${allFindings.length}`,
    );

    // Risk keywords should be present
    assertIncludesRisks(allFindings, exp.expected.must_include_risks!, "multi-risk-single-hunk");

    // files array should have correct count
    assert.equal(result.files.length, exp.expected.files_count!,
      `Expected ${exp.expected.files_count} file(s), got ${result.files.length}`);

    // Each file should have change_summary and findings array
    for (const fr of result.files) {
      assert.ok(fr.file, "FileReview must have file");
      assert.ok(typeof fr.change_summary === "string", "FileReview must have change_summary");
      assert.ok(Array.isArray(fr.findings), "FileReview.findings must be array");
    }

    // Omitted files should have reasons
    for (const omitted of result.omitted_files) {
      assert.ok(omitted.file, "Omitted file must have name");
      assert.ok(omitted.reason, "Omitted file must have reason");
    }

    // _meta.chunking must be present
    assert.ok(result._meta.chunking, "_meta.chunking must be present");
    assert.ok(typeof result._meta.chunking.total_chunks === "number");
  });

  it("handles empty diff gracefully", () => {
    const result = reviewDiffByFileFallback("");
    assert.equal(result.files.length, 0);
    assert.equal(result.top_risks.length, 0);
    assert.equal(result.omitted_files.length, 0);
    assert.equal(result.is_authoritative, false);
  });
});
