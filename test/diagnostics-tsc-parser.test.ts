/**
 * Tests for the TSC diagnostic state-machine parser.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  stripAnsi,
  parseTscDiagnostics,
  classifySourceKind,
} from "../src/diagnostics/tsc-parser.js";

// ── Fixtures ──────────────────────────────────────────────

/** Simulated tsc --noEmit output with 14 errors across 3 files. */
const FOURTEEN_TS_ERRORS = `src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/app.ts(15,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/app.ts(20,3): error TS18046: 'x' is of type 'unknown'.
src/app.ts(25,12): error TS2339: Property 'foo' does not exist on type 'Bar'.
src/utils.ts(8,1): error TS2304: Cannot find name 'process'.
src/utils.ts(12,5): error TS2532: Object is possibly 'undefined'.
src/utils.ts(18,9): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/utils.ts(22,7): error TS2554: Expected 2 arguments, but got 1.
src/utils.ts(30,3): error TS2307: Cannot find module 'unknown-lib'.
src/helpers.ts(5,10): error TS18047: 'obj' is possibly 'null'.
src/helpers.ts(11,8): error TS2367: This comparison appears to be unintentional.
src/helpers.ts(16,4): error TS6133: 'unused' is declared but its value is never read.
src/helpers.ts(20,6): error TS2322: Type 'number' is not assignable to type 'string'.
src/helpers.ts(25,2): error TS2588: Cannot assign to 'readonly' because it is a constant.
Found 14 errors in 3 files.
`;

/** Multi-line TS2344 error with type expansion detail. */
const MULTILINE_TS2344_ERROR = `src/types.ts(42,5): error TS2344: Type 'MyComplexType' does not satisfy the constraint 'Record<string, unknown>'.
  Type 'MyComplexType' is missing the following properties from type 'Record<string, unknown>': id, name, createdAt
src/other.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.
`;

/** TSC output with ANSI color codes (--pretty mode). */
const ANSI_TS_OUTPUT = `\x1b[96msrc/app.ts\x1b[0m:\x1b[93m10\x1b[0m:\x1b[93m5\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2345: \x1b[0mArgument of type 'string' is not assignable to parameter of type 'number'.
\x1b[7m10\x1b[0m \x1b[91m    foo("hello");\x1b[0m
\x1b[7m  \x1b[0m \x1b[91m    ~~~~~~~~~~~\x1b[0m

\x1b[96msrc/app.ts\x1b[0m:\x1b[93m15\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType 'string' is not assignable to type 'number'.

Found 2 errors in 1 file.
`;

/** Global error without file position. */
const GLOBAL_ERROR = `error TS5058: Directory 'nonexistent' does not exist.
error TS18003: No inputs were found in config file 'tsconfig.json'.
`;

/** TSC output with --watch mode restart. */
const WATCH_OUTPUT = `src/app.ts(5,3): error TS2322: Type 'string' is not assignable to type 'number'.
Found 1 error in 1 file.

Watching for file changes.
src/app.ts(8,5): error TS2345: Argument of type 'number' is not assignable to type 'string'.
Found 1 error in 1 file.

Watching for file changes.
`;

/** npm build wrapping tsc errors. */
const NPM_BUILD_OUTPUT = `src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/app.ts(15,7): error TS2322: Type 'string' is not assignable to type 'number'.
npm ERR! code ELIFECYCLE
npm ERR! errno 2
npm ERR! my-app@1.0.0 build: \`tsc --noEmit\`
npm ERR! Exit status 2
`;

/** Test output mixed in (boundary detection). */
const TEST_BOUNDARY = `src/app.ts(10,5): error TS2345: Type error here
FAIL src/app.test.ts
  × should work
Tests: 1 failed, 10 passed
`;

/** Windows paths with backslashes. */
const WINDOWS_PATHS = String.raw`src\app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src\utils\helpers.ts(20,3): error TS2322: Type 'number' is not assignable to type 'string'.
`;

/** Multi-line type expansion (complex TS2344). */
const COMPLEX_TYPE_EXPANSION = `src/models.ts(50,10): error TS2344: Type '{ id: number; name: string; nested: { deep: boolean; }; }' does not satisfy the constraint 'BaseModel'.
  The types of 'nested.deep' are incompatible between these types.
    Type 'boolean' is not assignable to type 'string'.
src/models.ts(55,3): error TS2322: Type 'number' is not assignable to type 'string'.
`;

// ── stripAnsi ─────────────────────────────────────────────

describe("stripAnsi", () => {
  it("strips color codes", () => {
    const input = "\x1b[96msrc/app.ts\x1b[0m:\x1b[93m10\x1b[0m";
    const result = stripAnsi(input);
    assert.equal(result, "src/app.ts:10");
  });

  it("preserves paths with Windows backslashes", () => {
    const input = String.raw`\x1b[96msrc\app.ts\x1b[0m:\x1b[93m10\x1b[0m`;
    const result = stripAnsi(input);
    assert.ok(result.includes(String.raw`src\app.ts`));
  });

  it("handles empty string", () => {
    assert.equal(stripAnsi(""), "");
  });

  it("handles text without ANSI codes unchanged", () => {
    const input = "src/app.ts:10:5 - error TS2345: message";
    assert.equal(stripAnsi(input), input);
  });
});

// ── classifySourceKind ────────────────────────────────────

describe("classifySourceKind", () => {
  it("classifies .next/ as generated", () => {
    assert.equal(classifySourceKind(".next/server/app/page.ts"), "generated");
  });

  it("classifies dist/ as generated", () => {
    assert.equal(classifySourceKind("dist/index.js"), "generated");
  });

  it("classifies build/ as generated", () => {
    assert.equal(classifySourceKind("build/static/js/main.js"), "generated");
  });

  it("classifies node_modules as dependency", () => {
    assert.equal(classifySourceKind("node_modules/react/index.d.ts"), "dependency");
  });

  it("classifies test files as test", () => {
    assert.equal(classifySourceKind("src/app.test.ts"), "test");
  });

  it("classifies spec files as test", () => {
    assert.equal(classifySourceKind("lib/foo.spec.tsx"), "test");
  });

  it("classifies src files as project", () => {
    assert.equal(classifySourceKind("src/app.ts"), "project");
  });

  it("classifies relative paths as project", () => {
    assert.equal(classifySourceKind("./app.ts"), "project");
    assert.equal(classifySourceKind("../lib/foo.ts"), "project");
  });

  it("returns unknown for undefined", () => {
    assert.equal(classifySourceKind(undefined), "unknown");
  });

  it("returns unknown for unrecognized pattern", () => {
    assert.equal(classifySourceKind("random-file.txt"), "unknown");
  });
});

// ── parseTscDiagnostics ───────────────────────────────────

describe("parseTscDiagnostics", () => {
  it("parses 14 tsc errors as 14 diagnostics", () => {
    const result = parseTscDiagnostics(FOURTEEN_TS_ERRORS);
    assert.equal(result.diagnostics.length, 14,
      `Expected 14 diagnostics, got ${result.diagnostics.length}`);
    // All should be type_error with high confidence
    for (const d of result.diagnostics) {
      assert.equal(d.kind, "type_error");
      assert.equal(d.parser_confidence, "high");
      assert.ok(d.file);
      assert.ok(d.line !== undefined);
      assert.ok(d.error_code);
    }
  });

  it("merges multi-line TS2344 into single diagnostic", () => {
    const result = parseTscDiagnostics(MULTILINE_TS2344_ERROR);
    // Should be 2 diagnostics, not 4+ (detail lines included)
    assert.equal(result.diagnostics.length, 2,
      `Expected 2 diagnostics, got ${result.diagnostics.length}`);

    const first = result.diagnostics[0];
    assert.equal(first.error_code, "TS2344");
    assert.equal(first.file, "src/types.ts");
    assert.equal(first.line, 42);
    assert.equal(first.column, 5);
    // Detail lines should be captured
    assert.ok(first.details.length >= 1,
      `Expected at least 1 detail line, got ${first.details.length}`);
    // Evidence should include header + details
    assert.ok(first.evidence.includes("does not satisfy"));
    assert.ok(first.evidence.includes("id, name, createdAt"));
  });

  it("strips ANSI codes and parses pretty format", () => {
    const result = parseTscDiagnostics(ANSI_TS_OUTPUT);
    assert.equal(result.diagnostics.length, 2,
      `Expected 2 diagnostics, got ${result.diagnostics.length}`);

    const first = result.diagnostics[0];
    assert.equal(first.file, "src/app.ts");
    assert.equal(first.line, 10);
    assert.equal(first.column, 5);
    assert.equal(first.error_code, "TS2345");
    // Evidence should NOT contain ANSI codes
    assert.ok(!first.evidence.includes("\x1b["),
      "Evidence should not contain ANSI codes");
    // Code frame should be in details
    const hasCodeFrame = first.details.some(d => d.includes("foo") || d.includes("~~~"));
    assert.ok(hasCodeFrame, "Code frame detail not captured");
  });

  it("parses global errors without file position", () => {
    const result = parseTscDiagnostics(GLOBAL_ERROR);
    assert.equal(result.diagnostics.length, 2);
    assert.equal(result.diagnostics[0].error_code, "TS5058");
    assert.equal(result.diagnostics[0].file, undefined);
    assert.equal(result.diagnostics[1].error_code, "TS18003");
  });

  it("terminates on 'Found N errors' summary", () => {
    const result = parseTscDiagnostics(FOURTEEN_TS_ERRORS);
    // The "Found 14 errors" line should NOT be part of any diagnostic
    assert.equal(result.diagnostics.length, 14);
    for (const d of result.diagnostics) {
      assert.ok(!d.evidence.includes("Found 14 errors"),
        `Diagnostic evidence contains summary line: ${d.id}`);
    }
  });

  it("terminates on 'Watching for file changes' in watch mode", () => {
    const result = parseTscDiagnostics(WATCH_OUTPUT);
    // Two diagnostics, NOT four (watch restarts are boundaries)
    assert.equal(result.diagnostics.length, 2,
      `Expected 2 diagnostics, got ${result.diagnostics.length}`);
    for (const d of result.diagnostics) {
      assert.ok(!d.evidence.includes("Watching for file changes"));
    }
  });

  it("terminates on npm ERR! boundary", () => {
    const result = parseTscDiagnostics(NPM_BUILD_OUTPUT);
    assert.equal(result.diagnostics.length, 2,
      `Expected 2 diagnostics, got ${result.diagnostics.length}`);
    for (const d of result.diagnostics) {
      assert.ok(!d.evidence.includes("npm ERR!"),
        "Diagnostic should not contain npm error lines");
    }
  });

  it("terminates on test FAIL boundary", () => {
    const result = parseTscDiagnostics(TEST_BOUNDARY);
    assert.equal(result.diagnostics.length, 1,
      `Expected 1 tsc diagnostic, got ${result.diagnostics.length}`);
    assert.equal(result.diagnostics[0].file, "src/app.ts");
  });

  it("parses Windows backslash paths", () => {
    const result = parseTscDiagnostics(WINDOWS_PATHS);
    assert.equal(result.diagnostics.length, 2);
    // First diagnostic with backslash path
    assert.ok(result.diagnostics[0].file!.includes("app.ts"),
      `Expected app.ts in file, got: ${result.diagnostics[0].file}`);
    assert.equal(result.diagnostics[0].line, 10);
    assert.equal(result.diagnostics[0].column, 5);
    assert.equal(result.diagnostics[0].error_code, "TS2345");
  });

  it("collects complex type expansion detail lines", () => {
    const result = parseTscDiagnostics(COMPLEX_TYPE_EXPANSION);
    assert.equal(result.diagnostics.length, 2);

    const first = result.diagnostics[0];
    assert.equal(first.error_code, "TS2344");
    // Should have captured the type expansion details
    assert.ok(first.details.length >= 2);
    const detailText = first.details.join("\n");
    assert.ok(detailText.includes("nested.deep"));
    assert.ok(detailText.includes("boolean"));
  });

  it("handles empty output gracefully", () => {
    const result = parseTscDiagnostics("");
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.unrecognized_segments.length, 0);
  });

  it("handles output with no tsc errors", () => {
    const result = parseTscDiagnostics("Everything is fine.\nNo errors here.");
    assert.equal(result.diagnostics.length, 0);
    assert.ok(result.unrecognized_segments.length > 0);
  });

  it("truncates oversized diagnostics", () => {
    // Build a diagnostic with a very long line to trigger truncation
    let longOutput = "src/big.ts(1,1): error TS2322: Type '" + "x".repeat(100) + "' is not assignable.\n";
    // Add many detail lines
    for (let i = 0; i < 100; i++) {
      longOutput += `  detail line ${i} with more content to fill up the buffer quickly\n`;
    }
    longOutput += "src/other.ts(1,1): error TS2345: Another error\n";

    const result = parseTscDiagnostics(longOutput, 500, 10); // Small limits
    assert.ok(result.diagnostics.length >= 1);
    // At least one should be truncated
    const truncated = result.diagnostics.filter(d => d.truncated);
    assert.ok(truncated.length >= 1,
      `Expected at least 1 truncated diagnostic, got ${truncated.length}`);
  });

  it("sets parser_confidence to high for well-formed diagnostics", () => {
    const result = parseTscDiagnostics(FOURTEEN_TS_ERRORS);
    for (const d of result.diagnostics) {
      assert.equal(d.parser_confidence, "high");
    }
  });

  it("correctly identifies source_kind", () => {
    const result = parseTscDiagnostics(FOURTEEN_TS_ERRORS);
    // All files are under src/ → project
    for (const d of result.diagnostics) {
      assert.equal(d.source_kind, "project",
        `Expected project for ${d.file}, got ${d.source_kind}`);
    }
  });

  it("classifies generated files correctly", () => {
    const output = String.raw`.next\server\page.ts(5,3): error TS2345: Error in generated file
src/app.ts(10,5): error TS2322: Error in project file
`;
    const result = parseTscDiagnostics(output);
    assert.equal(result.diagnostics.length, 2);

    const generated = result.diagnostics.find(d => d.file?.includes(".next"));
    assert.ok(generated);
    assert.equal(generated.source_kind, "generated");
    assert.equal(generated.actionability, "low");

    const project = result.diagnostics.find(d => d.file?.includes("src"));
    assert.ok(project);
    assert.equal(project.source_kind, "project");
    assert.equal(project.actionability, "high");
  });

  it("handles mixed unrecognized and diagnostic content", () => {
    const output = `Some preamble text
src/app.ts(10,5): error TS2345: Type error
Some middle text
src/app.ts(15,3): error TS2322: Another error
Some trailing text
`;
    const result = parseTscDiagnostics(output);
    assert.equal(result.diagnostics.length, 2);
    assert.ok(result.unrecognized_segments.length > 0);
  });

  it("generates stable diagnostic IDs", () => {
    const result1 = parseTscDiagnostics(FOURTEEN_TS_ERRORS);
    const result2 = parseTscDiagnostics(FOURTEEN_TS_ERRORS);
    assert.equal(result1.diagnostics.length, result2.diagnostics.length);
    for (let i = 0; i < result1.diagnostics.length; i++) {
      assert.equal(result1.diagnostics[i].id, result2.diagnostics[i].id);
    }
  });

  it("preserves original evidence with full context", () => {
    const result = parseTscDiagnostics(MULTILINE_TS2344_ERROR);
    const first = result.diagnostics[0];
    // Evidence should contain the header line
    assert.ok(first.evidence.includes("does not satisfy the constraint"));
    // Evidence should contain detail lines
    assert.ok(first.evidence.includes("missing the following properties"));
  });
});
