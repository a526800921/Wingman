/**
 * Tests for chunking modules — split, merge, and truncation.
 * Purely deterministic; no API key needed.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// chunking/command-output.ts
// ---------------------------------------------------------------------------

describe("chunkCommandOutput", () => {
  let chunkCommandOutput: Function;
  before(async () => {
    ({ chunkCommandOutput } = await import("../src/chunking/command-output.js"));
  });

  it("handles tsc output", () => {
    const tsc = "src/a.ts(1,1): error TS1234: bad\nsrc/b.ts(2,3): error TS5678: also bad";
    const result = chunkCommandOutput(tsc, 5000);
    assert.ok(result.chunks);
    assert.ok(result.meta);
    assert.ok(result.outputMeta);
  });

  it("handles generic text output", () => {
    const result = chunkCommandOutput("plain text output\nmore text", 5000);
    assert.ok(result.chunks);
    assert.ok(Array.isArray(result.chunks));
  });

  it("handles output with maxChars truncation", () => {
    const large = "line\n".repeat(5000);
    const result = chunkCommandOutput(large, 1000);
    assert.ok(result.chunks);
    assert.ok(result.meta.input_truncated);
  });
});

// ---------------------------------------------------------------------------
// chunking/merge.ts — deduplication and identity helpers
// ---------------------------------------------------------------------------

describe("chunking merge helpers", () => {
  let buildCommandFindingIdentity: Function;
  let isSameCommandFinding: Function;
  let deduplicateCommandFindings: Function;

  before(async () => {
    const mod = await import("../src/chunking/merge.js");
    buildCommandFindingIdentity = mod.buildCommandFindingIdentity;
    isSameCommandFinding = mod.isSameCommandFinding;
    deduplicateCommandFindings = mod.deduplicateCommandFindings;
  });

  it("buildCommandFindingIdentity creates identity object", () => {
    const id = buildCommandFindingIdentity({
      kind: "test_failure",
      message: "should work",
      file: "src/test.ts",
      error_code: "ERR",
    });
    assert.equal(id.normalizedKind, "test_failure");
    assert.ok(id.normalizedMessage.includes("should work"));
    assert.equal(id.file, "src/test.ts");
    assert.equal(id.errorCode, "ERR");
  });

  it("isSameCommandFinding matches identical findings", () => {
    const a = buildCommandFindingIdentity({ kind: "error", message: "broken", file: "a.ts" });
    const b = buildCommandFindingIdentity({ kind: "error", message: "broken", file: "a.ts" });
    assert.equal(isSameCommandFinding(a, b), true);
  });

  it("isSameCommandFinding rejects different kinds", () => {
    const a = buildCommandFindingIdentity({ kind: "error", message: "x" });
    const b = buildCommandFindingIdentity({ kind: "warning", message: "x" });
    assert.equal(isSameCommandFinding(a, b), false);
  });

  it("deduplicateCommandFindings removes duplicates", () => {
    const findings = [
      { kind: "error", message: "dup", evidence: "e1", confidence: "high" },
      { kind: "error", message: "dup", evidence: "e2", confidence: "medium" },
      { kind: "warning", message: "unique", evidence: "e3", confidence: "low" },
    ];
    const result = deduplicateCommandFindings(findings);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2, "Should deduplicate 3 → 2");
  });

  it("deduplicateCommandFindings handles empty array", () => {
    const result = deduplicateCommandFindings([]);
    assert.deepStrictEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// model-runtime/truncation.ts
// ---------------------------------------------------------------------------

describe("smart truncation (splitPrefixSuffix)", () => {
  let splitPrefixSuffix: Function;
  let joinPrefixSuffix: Function;
  before(async () => {
    ({ splitPrefixSuffix, joinPrefixSuffix } = await import("../src/model-runtime/truncation.js"));
  });

  it("returns full text when within budget", () => {
    const result = splitPrefixSuffix("short", 1000);
    assert.equal(result.truncated, false);
    assert.equal(result.prefix, "short");
    assert.equal(result.suffix, "");
  });

  it("splits text at 60/40 ratio when exceeded", () => {
    const text = "A\n".repeat(500);
    const result = splitPrefixSuffix(text, 100);
    assert.equal(result.truncated, true);
    assert.ok(result.prefix.length > 0);
    assert.ok(result.suffix.length > 0);
    assert.ok(result.omittedChars > 0);
  });

  it("joinPrefixSuffix includes omission marker", () => {
    const joined = joinPrefixSuffix("PREFIX", "SUFFIX", 100);
    assert.ok(joined.includes("PREFIX"));
    assert.ok(joined.includes("SUFFIX"));
    assert.ok(joined.includes("100"));
    assert.ok(joined.includes("omitted"));
  });

  it("joinPrefixSuffix returns just prefix when no suffix", () => {
    const joined = joinPrefixSuffix("PREFIX", "", 0);
    assert.equal(joined, "PREFIX");
  });
});
