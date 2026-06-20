/**
 * Command Output 模型响应契约恢复 — 红灯测试
 *
 * 这些测试验证 Round 4 模型响应契约回归问题：
 * 1. Schema strict parse 导致 null optional / 额外字段时整体失败
 * 2. 单个非法 finding 清空同一响应中的其他合法 findings
 * 3. Parse/schema/transport failure 不可区分
 *
 * 测试不依赖真实远程模型 — 直接测试 Schema 行为和 decodeModelFirstResponse。
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  ModelFirstResponseSchema,
  ModelFirstFindingSchema,
} from "../src/schema.js";
import {
  decodeModelFirstResponse,
  type DecodedModelFirstResponse,
  type ModelResponseStatus,
} from "../src/decoding/command-output-decoder.js";

// ── Round 4 Fixture: 14 tsc diagnostics ────────────────────

const ROUND4_FIXTURE = `src/services/auth.ts(50,10): error TS2345: Argument of type 'null' is not assignable.
src/services/auth.ts(50,10): error TS2345: Argument of type 'undefined' is not assignable.
src/services/auth.ts(50,10): error TS2345: Argument of type 'string[]' is not assignable.
src/services/auth.ts(50,10): error TS2345: Type 'X' does not satisfy constraint 'Y'.
src/services/auth.ts(50,10): error TS2345: Object literal may only specify known properties.
src/services/auth.ts(50,10): error TS2345: Expected 2 arguments but got 1.
src/services/auth.ts(50,10): error TS2345: Cannot find name 'process'.
src/models.ts(55,4): error TS2322: Type 'number' is not assignable to type 'string'.
src/services/auth.ts(22,6): error TS7053: Element implicitly has an 'any' type.
src/services/auth.ts(24,8): error TS7053: No index signature with a parameter of type 'string'.
src/handler.ts(88,12): error TS2339: Property 'validated' does not exist on type 'Response'.
src/handler.ts(88,12): error TS2339: Property 'data' does not exist on type 'unknown'.
src/utils.ts(8,1): error TS2304: Cannot find name 'process'.
src/utils.ts(12,5): error TS2304: Cannot find name 'Buffer'.
Found 14 errors in 4 files.
`;

describe("ModelFirstResponseSchema — Round 4 red-light tests", () => {
  // ── Scenario 1: null optional fields cause full rejection ─

  it("RED: null optional fields (file/line/error_code: null) cause schema rejection", () => {
    const response = {
      detected_kind: "tsc_error",
      findings: [
        {
          finding_id: "f0",
          kind: "type_error",
          message: "Type error in auth service",
          file: null,
          line: null,
          column: null,
          error_code: null,
          evidence: "src/services/auth.ts(50,10): error TS2345",
          confidence: "high",
        },
      ],
    };

    const result = ModelFirstResponseSchema.safeParse(response);

    // RED: Current strict schema rejects null for optional fields
    // Expected after fix: normalize null→undefined, accept the finding
    assert.equal(result.success, false,
      "RED: null optional fields should currently fail (expected to pass after fix)");
  });

  // ── Scenario 2: extra fields cause rejection ──────────────

  it("RED: extra field (rule_id) causes schema rejection", () => {
    const response = {
      detected_kind: "tsc_error",
      findings: [
        {
          finding_id: "f0",
          kind: "type_error",
          message: "Type error with rule_id",
          file: "src/app.ts",
          line: 10,
          evidence: "src/app.ts(10,5): error TS2345",
          confidence: "high",
          rule_id: "no-extra-fields-allowed",
        },
      ],
    };

    const result = ModelFirstResponseSchema.safeParse(response);

    // RED: Current strict schema rejects unrecognized keys
    // Expected after fix: strip unknown fields, accept the finding
    assert.equal(result.success, false,
      "RED: extra field rule_id should currently fail (expected to pass after fix)");
  });

  // ── Scenario 3: one invalid finding kills all ─────────────

  it("RED: one invalid finding (out of 3) causes ALL findings to be rejected", () => {
    const response = {
      detected_kind: "tsc_error",
      findings: [
        {
          finding_id: "f0",
          kind: "type_error",
          message: "Valid finding — should survive",
          file: "src/a.ts",
          line: 1,
          evidence: "src/a.ts(1,1): error TS2345",
          confidence: "high",
        },
        {
          finding_id: "f1",
          kind: "type_error",
          message: "Second valid finding — should also survive",
          file: "src/b.ts",
          line: 2,
          evidence: "src/b.ts(2,2): error TS2322",
          confidence: "high",
        },
        {
          finding_id: "f2",
          kind: "type_error",
          message: "Invalid — has null file",
          file: null, // ⚠ makes entire array fail
          evidence: "some error",
          confidence: "high",
        },
      ],
    };

    const result = ModelFirstResponseSchema.safeParse(response);

    // RED: All findings lost because one is invalid
    assert.equal(result.success, false,
      "RED: one invalid finding should currently reject all 3 findings");

    // After fix: we expect 2 valid findings retained, 1 rejected
    // This assertion will flip when the fix is applied
  });

  // ── Scenario 4: valid response with all fields ────────────

  it("GREEN: fully valid response passes schema (baseline)", () => {
    const response = {
      detected_kind: "tsc_error",
      findings: [
        {
          finding_id: "f0",
          kind: "type_error",
          message: "Type error",
          file: "src/app.ts",
          line: 10,
          column: 5,
          error_code: "TS2345",
          evidence: "src/app.ts(10,5): error TS2345",
          confidence: "high",
        },
      ],
    };

    const result = ModelFirstResponseSchema.safeParse(response);
    assert.equal(result.success, true,
      "Fully valid response should always pass");
    assert.equal(result.data!.findings.length, 1);
  });

  // ── Scenario 5: empty findings array (non-zero exit) ──────

  it("GREEN: valid empty findings array passes schema", () => {
    const response = {
      detected_kind: "generic_log",
      findings: [],
      summary: "No actionable findings detected.",
    };

    const result = ModelFirstResponseSchema.safeParse(response);
    assert.equal(result.success, true);
    assert.equal(result.data!.findings.length, 0);
  });

  // ── Scenario 6: illegal JSON / truncation ─────────────────

  it("RED: truncated JSON (missing closing brace) is unparseable", () => {
    const truncated = '{"detected_kind":"tsc_error","findings":[';

    let parseFailed = false;
    try {
      JSON.parse(truncated);
    } catch {
      parseFailed = true;
    }

    assert.equal(parseFailed, true,
      "RED: truncated JSON should fail at parse level (not schema level)");
  });

  // ── Scenario 7: envelope failure (missing findings) ───────

  it("RED: envelope failure (missing findings array) is indistinguishable from per-finding failure", () => {
    const response = {
      detected_kind: "tsc_error",
      summary: "some summary",
      // missing findings array
    };

    const result = ModelFirstResponseSchema.safeParse(response);

    // RED: Currently schema validation failure doesn't distinguish
    // "missing findings array" from "one finding had null file"
    assert.equal(result.success, false,
      "RED: envelope failure should fail (but should be distinguishable from finding-level failure)");
  });

  // ── Scenario 8: 14 valid findings → all 14 retained ──────

  it("GREEN: 14 valid findings all pass schema (target state)", () => {
    const errorCodes = ["TS2345", "TS2322", "TS7053", "TS2339", "TS2304"];
    const findings = Array.from({ length: 14 }, (_, i) => ({
      finding_id: `f${i}`,
      kind: "type_error" as const,
      message: `Error ${i + 1}`,
      file: `src/file${i}.ts`,
      line: i + 1,
      error_code: errorCodes[i % errorCodes.length],
      evidence: `src/file${i}.ts(${i + 1},1): error ${errorCodes[i % errorCodes.length]}`,
      confidence: "high" as const,
    }));

    const response = {
      detected_kind: "tsc_error",
      findings,
    };

    const result = ModelFirstResponseSchema.safeParse(response);
    assert.equal(result.success, true,
      "14 valid findings should all pass");
    assert.equal(result.data!.findings.length, 14);
  });
});

// ── ModelFirstFindingSchema 契约 ────────────────────────────

describe("ModelFirstFindingSchema — finding-level contracts", () => {
  it("requires finding_id, kind, message, evidence, confidence", () => {
    // Missing finding_id
    const r1 = ModelFirstFindingSchema.safeParse({
      kind: "type_error",
      message: "test",
      evidence: "evidence",
      confidence: "high",
    });
    assert.equal(r1.success, false, "Missing finding_id should fail");

    // Missing message
    const r2 = ModelFirstFindingSchema.safeParse({
      finding_id: "f0",
      kind: "type_error",
      evidence: "evidence",
      confidence: "high",
    });
    assert.equal(r2.success, false, "Missing message should fail");
  });

  it("accepts optional fields omitted (undefined, not null)", () => {
    const r = ModelFirstFindingSchema.safeParse({
      finding_id: "f0",
      kind: "type_error",
      message: "test",
      evidence: "evidence",
      confidence: "high",
      // file, line, column, error_code, test_name all omitted
    });
    assert.equal(r.success, true,
      "Optional fields omitted (undefined) should pass");
  });

  it("rejects null for optional string fields (current behavior)", () => {
    const r = ModelFirstFindingSchema.safeParse({
      finding_id: "f0",
      kind: "type_error",
      message: "test",
      file: null,
      evidence: "evidence",
      confidence: "high",
    });
    assert.equal(r.success, false,
      "RED: null optional field should currently fail (expected to be normalized)");
  });
});

// ── decodeModelFirstResponse — 新解码器测试（绿灯目标） ─────

function json(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("decodeModelFirstResponse — layered validation (target: green)", () => {
  // ── Parse failure ──────────────────────────────────────

  it("returns parse_failure for truncated JSON", () => {
    const result = decodeModelFirstResponse('{"detected_kind":"tsc_error","findings":[');
    assert.equal(result.status, "parse_failure");
    assert.equal(result.accepted_findings.length, 0);
    assert.equal(result.rejected_issues.length, 0);
  });

  it("returns parse_failure for non-JSON text", () => {
    const result = decodeModelFirstResponse("This is not JSON at all.");
    assert.equal(result.status, "parse_failure");
  });

  // ── Schema / envelope failure ──────────────────────────

  it("returns schema_failure for missing findings array", () => {
    const result = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      summary: "some summary",
    }));
    assert.equal(result.status, "schema_failure");
  });

  it("returns schema_failure for missing detected_kind", () => {
    const result = decodeModelFirstResponse(json({
      findings: [],
    }));
    assert.equal(result.status, "schema_failure");
  });

  it("returns schema_failure for non-object response", () => {
    const result = decodeModelFirstResponse("42");
    assert.equal(result.status, "schema_failure");
  });

  // ── Empty findings ─────────────────────────────────────

  it("returns empty for valid envelope with empty findings array", () => {
    const result = decodeModelFirstResponse(json({
      detected_kind: "generic_log",
      findings: [],
      summary: "No issues found",
    }));
    assert.equal(result.status, "empty");
    assert.equal(result.detected_kind, "generic_log");
    assert.equal(result.summary, "No issues found");
    assert.equal(result.accepted_findings.length, 0);
  });

  // ── Fully valid response ───────────────────────────────

  it("returns valid for 14 fully valid findings", () => {
    const errorCodes = ["TS2345", "TS2322", "TS7053", "TS2339", "TS2304"];
    const findings = Array.from({ length: 14 }, (_, i) => ({
      finding_id: `f${i}`,
      kind: "type_error",
      message: `Error ${i + 1}`,
      file: `src/file${i}.ts`,
      line: i + 1,
      error_code: errorCodes[i % errorCodes.length],
      evidence: `src/file${i}.ts(${i + 1},1): error ${errorCodes[i % errorCodes.length]}`,
      confidence: "high",
    }));

    const result = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      findings,
      reported_totals: { errors: 14, failed_files: 4 },
    }));

    assert.equal(result.status, "valid");
    assert.equal(result.accepted_findings.length, 14);
    assert.equal(result.rejected_issues.length, 0);
    assert.equal(result.detected_kind, "tsc_error");
    assert.equal(result.reported_totals?.errors, 14);
  });

  // ── Null normalization ─────────────────────────────────

  it("normalizes null optional fields → retains finding (was RED, now GREEN)", () => {
    const result = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      findings: [{
        finding_id: "f0",
        kind: "type_error",
        message: "Type error in auth service",
        file: null,
        line: null,
        column: null,
        error_code: null,
        evidence: "src/services/auth.ts(50,10): error TS2345",
        confidence: "high",
      }],
    }));

    assert.equal(result.status, "valid",
      `Expected valid, got ${result.status}`);
    assert.equal(result.accepted_findings.length, 1,
      "Should retain finding after null normalization");
    assert.equal(result.accepted_findings[0].finding_id, "f0");
    // Optional fields should be undefined after normalization
    assert.equal(result.accepted_findings[0].file, undefined);
    assert.equal(result.accepted_findings[0].line, undefined);
  });

  // ── Extra field stripping ──────────────────────────────

  it("strips unknown fields (rule_id) → retains finding (was RED, now GREEN)", () => {
    const result = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      findings: [{
        finding_id: "f0",
        kind: "type_error",
        message: "Type error with extra field",
        file: "src/app.ts",
        line: 10,
        evidence: "src/app.ts(10,5): error TS2345",
        confidence: "high",
        rule_id: "no-extra-fields-allowed",
      }],
    }));

    assert.equal(result.status, "valid",
      `Expected valid, got ${result.status}: ${result.rejected_issues.map(r => r.reason).join("; ")}`);
    assert.equal(result.accepted_findings.length, 1,
      "Should retain finding after stripping unknown fields");
  });

  // ── Partial valid: one invalid finding doesn't kill others ─

  it("retains 2 valid findings, rejects 1 invalid (was RED, now GREEN)", () => {
    const result = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      findings: [
        {
          finding_id: "f0",
          kind: "type_error",
          message: "Valid finding — should survive",
          file: "src/a.ts",
          line: 1,
          evidence: "src/a.ts(1,1): error TS2345",
          confidence: "high",
        },
        {
          finding_id: "f1",
          kind: "type_error",
          message: "Second valid finding — should also survive",
          file: "src/b.ts",
          line: 2,
          evidence: "src/b.ts(2,2): error TS2322",
          confidence: "high",
        },
        {
          finding_id: "f2",
          kind: "type_error",
          message: "Invalid — missing evidence",
          // missing evidence → should be rejected
          confidence: "high",
        },
      ],
    }));

    assert.equal(result.status, "partial_valid",
      `Expected partial_valid, got ${result.status}`);
    assert.equal(result.accepted_findings.length, 2,
      "Should retain 2 valid findings");
    assert.equal(result.rejected_issues.length, 1,
      "Should reject 1 invalid finding");
    assert.equal(result.rejected_issues[0].index, 2,
      "Rejected finding should be at index 2");
    assert.ok(result.rejected_issues[0].reason.includes("evidence"),
      `Rejection reason should mention evidence: ${result.rejected_issues[0].reason}`);
  });

  // ── Missing required field ─────────────────────────────

  it("rejects finding missing required field (finding_id)", () => {
    const result = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      findings: [{
        kind: "type_error",
        message: "test",
        evidence: "evidence",
        confidence: "high",
      }],
    }));

    assert.equal(result.status, "partial_valid");
    assert.equal(result.accepted_findings.length, 0);
    assert.equal(result.rejected_issues.length, 1);
    assert.ok(result.rejected_issues[0].reason.includes("finding_id"),
      "Reason should mention missing finding_id");
  });

  // ── Non-object finding ─────────────────────────────────

  it("rejects non-object finding entries", () => {
    const result = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      findings: [
        "not an object",
        {
          finding_id: "f1",
          kind: "type_error",
          message: "Valid finding",
          evidence: "some evidence",
          confidence: "high",
        },
      ],
    }));

    assert.equal(result.status, "partial_valid");
    assert.equal(result.accepted_findings.length, 1);
    assert.equal(result.rejected_issues.length, 1);
    assert.equal(result.rejected_issues[0].index, 0);
  });

  // ── Uncertainties passthrough ──────────────────────────

  it("preserves uncertainties from valid response", () => {
    const result = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      findings: [],
      uncertainties: ["Footer says 14 errors but only 10 found in output"],
    }));

    assert.equal(result.status, "empty");
    assert.equal(result.uncertainties!.length, 1);
  });

  // ── Partial non-array uncertainties ─────────────────────

  it("filters non-string uncertainties entries", () => {
    const result = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      findings: [],
      uncertainties: [42, "valid uncertainty", null],
    }));

    assert.equal(result.status, "empty");
    assert.equal(result.uncertainties!.length, 1);
    assert.equal(result.uncertainties![0], "valid uncertainty");
  });

  // ── Envelope with extra fields ─────────────────────────

  it("strips unknown envelope fields", () => {
    const result = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      findings: [],
      extra_field: "should be stripped",
      another_unknown: 123,
    }));

    assert.equal(result.status, "empty");
    assert.equal(result.detected_kind, "tsc_error");
  });

  // ── reported_totals parsing ────────────────────────────

  it("parses reported_totals with valid number values", () => {
    const result = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      findings: [],
      reported_totals: { errors: 14, warnings: 2, failed_files: 4 },
    }));

    assert.equal(result.status, "empty");
    assert.equal(result.reported_totals?.errors, 14);
    assert.equal(result.reported_totals?.warnings, 2);
    assert.equal(result.reported_totals?.failed_files, 4);
  });

  // ── Status distinguishes empty vs schema_failure ───────

  it("distinguishes empty (valid, no findings) from schema_failure", () => {
    const empty = decodeModelFirstResponse(json({
      detected_kind: "generic_log",
      findings: [],
    }));
    assert.equal(empty.status, "empty");

    const fail = decodeModelFirstResponse(json({
      detected_kind: "tsc_error",
      // missing findings
    }));
    assert.equal(fail.status, "schema_failure");
  });

  // ── Status distinguishes parse_failure vs schema_failure ─

  it("distinguishes parse_failure from schema_failure", () => {
    const pf = decodeModelFirstResponse("not json{{{");
    assert.equal(pf.status, "parse_failure");

    const sf = decodeModelFirstResponse(json({ detected_kind: "tsc_error" }));
    assert.equal(sf.status, "schema_failure");
  });
});
