import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compressCommandOutputFallback } from "../src/fallback/compress-command-output.js";

describe("compressCommandOutputFallback", () => {
  it("extracts tsc errors with file, line, column, and error_code", () => {
    const output = "src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to 'number'";
    const result = compressCommandOutputFallback("tsc", output, 2);
    const tscErrors = result.findings.filter(f => f.kind === "type_error");
    assert.ok(tscErrors.length > 0, "Should extract tsc errors");
    assert.equal(tscErrors[0].error_code, "TS2345");
    assert.equal(tscErrors[0].file, "src/app.ts");
    assert.equal(tscErrors[0].line, 10);
    assert.equal(tscErrors[0].column, 5);
  });

  it("extracts eslint errors with rule_id", () => {
    const output = "  12:34  error  Missing semicolon  semi";
    const result = compressCommandOutputFallback(undefined, output, undefined);
    const lintErrors = result.findings.filter(f => f.kind === "lint_error");
    assert.ok(lintErrors.length > 0, "Should extract eslint errors");
    assert.equal(lintErrors[0].rule_id, "semi");
  });

  it("extracts test failure names", () => {
    const output = "FAIL src/feature.test.ts\n  × should handle edge case correctly\n  × should validate input";
    const result = compressCommandOutputFallback("npm test", output, 1);
    const failures = result.findings.filter(f => f.kind === "test_failure");
    assert.ok(failures.length >= 1, "Should extract test failures");
  });

  it("extracts stack trace with first non-node_modules frame", () => {
    const output = "TypeError: Cannot read property 'x' of undefined\n    at doStuff (src/util.ts:42:10)\n    at node_modules/leftpad/index.js:1:1";
    const result = compressCommandOutputFallback(undefined, output, undefined);
    const traces = result.findings.filter(f => f.kind === "runtime_exception");
    assert.ok(traces.length > 0, "Should extract stack traces");
    // Should skip node_modules frame and capture the business code frame
    const firstTrace = traces[0];
    assert.ok(
      firstTrace.file?.includes("src/util.ts") || firstTrace.evidence.includes("src/util.ts"),
      `Expected util.ts in finding, got file: ${firstTrace.file}, evidence: ${firstTrace.evidence}`
    );
  });

  it("redacts secrets in evidence", () => {
    const output = "ERROR: api_key=sk-abc123def456ghi789jkl012";
    const result = compressCommandOutputFallback(undefined, output, undefined);
    for (const f of result.findings) {
      assert.ok(!f.evidence.includes("sk-abc123"), `Evidence must not contain raw secret: ${f.evidence}`);
    }
  });

  it("merges repeated errors with count", () => {
    // Use tsc errors in different files so they survive dedup (dedup key includes file)
    const output = [
      "src/a.ts(1,1): error TS1000: timeout connecting",
      "src/b.ts(2,2): error TS1000: timeout connecting",
      "src/c.ts(3,3): error TS1000: timeout connecting",
      "src/d.ts(4,4): warning TS9999: disk nearly full",
    ].join("\n");
    const result = compressCommandOutputFallback("tsc", output, 1);
    const timeoutEntry = result.repeated_errors.find(e =>
      e.message.toLowerCase().includes("timeout")
    );
    assert.ok(timeoutEntry, "Should merge repeated timeout errors");
    assert.ok(timeoutEntry.count >= 2, `Should count repeated errors correctly, got ${timeoutEntry.count}`);
    assert.ok(timeoutEntry.examples.length >= 1, "Should include examples");
  });

  it("identifies first_failure", () => {
    const output = "src/a.ts(1,1): error TS1000: first error\nsrc/b.ts(2,2): error TS2000: second error";
    const result = compressCommandOutputFallback("tsc", output, 2);
    assert.ok(result.first_failure, "Should identify first failure");
    assert.ok(result.first_failure.message.includes("first error"));
  });

  it("returns is_authoritative false", () => {
    const result = compressCommandOutputFallback(undefined, "some output", undefined);
    assert.equal(result.is_authoritative, false);
  });

  it("includes suggested source checks for files with errors", () => {
    const output = "src/app.ts(10,5): error TS2345: type error";
    const result = compressCommandOutputFallback("tsc", output, 1);
    assert.ok(result.suggested_source_checks.length > 0, "Should suggest source checks");
  });

  it("suggests next commands for known output types", () => {
    const tscResult = compressCommandOutputFallback("tsc", "src/a.ts(1,1): error TS1000: err", 1);
    assert.ok(tscResult.suggested_next_commands.length > 0, "Should suggest next commands for tsc");

    const testResult = compressCommandOutputFallback("npm test", "FAIL src/test.ts\n  × broke", 1);
    assert.ok(testResult.suggested_next_commands.length > 0, "Should suggest next commands for tests");
  });
});
