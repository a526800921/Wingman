import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectOutputKind, chunkCommandOutput } from "../src/chunking/command-output.js";

describe("detectOutputKind", () => {
  it("detects TypeScript errors", () => {
    assert.equal(
      detectOutputKind("src/file.ts(10,5): error TS2345: Argument of type 'string' is not assignable"),
      "tsc_error"
    );
  });

  it("detects ESLint output", () => {
    assert.equal(
      detectOutputKind("  12:34  error  Missing semicolon  semi\n\n✖ 1 problem (1 error, 0 warnings)"),
      "eslint_output"
    );
  });

  it("detects test failures", () => {
    assert.equal(
      detectOutputKind("FAIL src/test.ts\n  × should do something\n  × should also do that"),
      "test_output"
    );
  });

  it("detects stack traces", () => {
    assert.equal(
      detectOutputKind("Error: something went wrong\n    at doStuff (src/util.ts:42:10)\n    at main (src/app.ts:20:1)"),
      "stack_trace"
    );
  });

  it("detects build errors", () => {
    assert.equal(
      detectOutputKind("ERROR in src/app.ts\nModule not found"),
      "build_output"
    );
  });

  it("defaults to generic_log for unknown format", () => {
    assert.equal(detectOutputKind("some random output\nwith no patterns"), "generic_log");
  });
});

describe("chunkCommandOutput", () => {
  it("handles empty output", () => {
    const { chunks, outputMeta } = chunkCommandOutput("");
    // Empty string produces one empty chunk (the generic output path creates
    // a "full output" chunk even when there are no lines with signal keywords)
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, "");
    assert.equal(outputMeta.kind, "generic_log");
  });

  it("handles truncation when output exceeds maxChars", () => {
    const long = "x".repeat(2000);
    const { meta } = chunkCommandOutput(long, 1000);
    assert.ok(meta.input_truncated);
    assert.ok(meta.omitted.length > 0);
  });

  it("detects tsc output kind and chunks errors", () => {
    const output = "src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable";
    const { outputMeta, chunks, meta } = chunkCommandOutput(output);
    assert.equal(outputMeta.kind, "tsc_error");
    assert.ok(chunks.length > 0, "Should produce chunks for tsc errors");
    assert.ok(meta.chunking_strategy.includes("tsc_error"));
  });
});
