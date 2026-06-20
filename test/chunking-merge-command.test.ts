/**
 * Tests for command output finding dedup and merge utilities.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildCommandFindingIdentity,
  isSameCommandFinding,
  deduplicateCommandFindings,
  sortFindings,
} from "../src/chunking/merge.js";

// ── buildCommandFindingIdentity ───────────────────────────

describe("buildCommandFindingIdentity", () => {
  it("creates identity from kind + message + file + error_code", () => {
    const id = buildCommandFindingIdentity({
      kind: "type_error",
      message: "Type string not assignable to number",
      file: "src/app.ts",
      error_code: "TS2322",
    });
    assert.equal(id.normalizedKind, "type_error");
    assert.equal(id.normalizedMessage, "type string not assignable to number");
    assert.equal(id.file, "src/app.ts");
    assert.equal(id.errorCode, "TS2322");
  });

  it("handles missing fields gracefully", () => {
    const id = buildCommandFindingIdentity({
      message: "Something wrong",
    });
    assert.equal(id.normalizedKind, "");
    assert.equal(id.file, undefined);
    assert.equal(id.errorCode, undefined);
  });

  it("truncates long messages to 200 chars", () => {
    const longMsg = "x".repeat(300);
    const id = buildCommandFindingIdentity({
      kind: "unknown",
      message: longMsg,
    });
    assert.equal(id.normalizedMessage.length, 200);
  });
});

// ── isSameCommandFinding ──────────────────────────────────

describe("isSameCommandFinding", () => {
  it("matches identical identities", () => {
    const a = buildCommandFindingIdentity({
      kind: "type_error", message: "Foo", file: "x.ts", error_code: "TS1234",
    });
    const b = buildCommandFindingIdentity({
      kind: "type_error", message: "Foo", file: "x.ts", error_code: "TS1234",
    });
    assert.ok(isSameCommandFinding(a, b));
  });

  it("rejects different kinds", () => {
    const a = buildCommandFindingIdentity({ kind: "type_error", message: "Foo" });
    const b = buildCommandFindingIdentity({ kind: "lint_error", message: "Foo" });
    assert.ok(!isSameCommandFinding(a, b));
  });

  it("rejects different files when both present", () => {
    const a = buildCommandFindingIdentity({ kind: "type_error", message: "Foo", file: "a.ts" });
    const b = buildCommandFindingIdentity({ kind: "type_error", message: "Foo", file: "b.ts" });
    assert.ok(!isSameCommandFinding(a, b));
  });

  it("rejects different error codes when both present", () => {
    const a = buildCommandFindingIdentity({ kind: "type_error", message: "Foo", error_code: "TS1234" });
    const b = buildCommandFindingIdentity({ kind: "type_error", message: "Foo", error_code: "TS5678" });
    assert.ok(!isSameCommandFinding(a, b));
  });

  it("matches message substring (model rephrasing)", () => {
    const a = buildCommandFindingIdentity({
      kind: "type_error",
      message: "Type 'string' is not assignable to type 'number'",
    });
    const b = buildCommandFindingIdentity({
      kind: "type_error",
      message: "not assignable to type",
    });
    assert.ok(isSameCommandFinding(a, b));
  });

  it("handles empty messages", () => {
    const a = buildCommandFindingIdentity({ kind: "type_error", message: "" });
    const b = buildCommandFindingIdentity({ kind: "type_error", message: "some message" });
    // Empty shorter string is substring of any string, but our logic checks
    // `if (shorter && longer)` — empty is falsy, so skips message comparison
    assert.ok(isSameCommandFinding(a, b));
  });
});

// ── deduplicateCommandFindings ────────────────────────────

describe("deduplicateCommandFindings", () => {
  it("deduplicates by identity", () => {
    const findings = [
      { kind: "type_error", message: "Error A", file: "a.ts", error_code: "TS1", confidence: "high" },
      { kind: "type_error", message: "Error A", file: "a.ts", error_code: "TS1", confidence: "high" },
      { kind: "type_error", message: "Error B", file: "b.ts", error_code: "TS2", confidence: "medium" },
    ];
    const result = deduplicateCommandFindings(findings);
    assert.equal(result.length, 2);
  });

  it("keeps higher confidence on collision", () => {
    const findings = [
      { kind: "type_error", message: "Error X", confidence: "low" },
      { kind: "type_error", message: "Error X", confidence: "high" },
    ];
    const result = deduplicateCommandFindings(findings);
    assert.equal(result.length, 1);
    assert.equal(result[0].confidence, "high");
  });

  it("preserves first_seen_index order", () => {
    const findings = [
      { kind: "type_error", message: "Error C", confidence: "high" },
      { kind: "type_error", message: "Error A", confidence: "high" },
      { kind: "type_error", message: "Error B", confidence: "high" },
    ];
    const result = deduplicateCommandFindings(findings);
    assert.equal(result.length, 3);
    assert.equal(result[0].message, "Error C");
    assert.equal(result[1].message, "Error A");
  });

  it("handles empty array", () => {
    const result = deduplicateCommandFindings([]);
    assert.equal(result.length, 0);
  });

  it("keeps different error codes as distinct", () => {
    const findings = [
      { kind: "type_error", message: "Error", error_code: "TS2322", confidence: "high" },
      { kind: "type_error", message: "Error", error_code: "TS2345", confidence: "high" },
    ];
    const result = deduplicateCommandFindings(findings);
    assert.equal(result.length, 2);
  });
});

// ── sortFindings with actionability ───────────────────────

describe("sortFindings", () => {
  it("sorts by actionability first", () => {
    const findings = [
      { severity: "high", confidence: "high", actionability: "low", first_seen_index: 0 },
      { severity: "high", confidence: "high", actionability: "high", first_seen_index: 1 },
      { severity: "high", confidence: "high", actionability: "medium", first_seen_index: 2 },
    ];
    const sorted = sortFindings(findings);
    assert.equal(sorted[0].actionability, "high");
    assert.equal(sorted[1].actionability, "medium");
    assert.equal(sorted[2].actionability, "low");
  });

  it("falls back to severity when no actionability", () => {
    const findings = [
      { severity: "medium", confidence: "high", first_seen_index: 0 },
      { severity: "high", confidence: "high", first_seen_index: 1 },
    ];
    const sorted = sortFindings(findings);
    assert.equal(sorted[0].severity, "high");
    assert.equal(sorted[1].severity, "medium");
  });

  it("preserves original order for equal sort keys", () => {
    const findings = [
      { severity: "high", confidence: "high", first_seen_index: 5 },
      { severity: "high", confidence: "high", first_seen_index: 3 },
    ];
    const sorted = sortFindings(findings);
    assert.equal(sorted[0].first_seen_index, 3);
    assert.equal(sorted[1].first_seen_index, 5);
  });
});
