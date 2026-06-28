/**
 * Step 0 红灯测试 — MCP Tool Feedback Loop
 *
 * 三个 Fixture，全部预期在当前代码下失败（红灯），
 * 证明缺少 trace_id / tool_name 暴露、反馈工具和隐私/长度限制。
 *
 * 运行: node --import tsx --test test/mcp-tool-feedback-loop.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TMP_DIR = join(__dirname, "..", "tmp_feedback_test");

// ── Environment setup: no API key, clean workspace ──────────
const savedKey = process.env.AUX_MODEL_API_KEY;
delete process.env.AUX_MODEL_API_KEY;
process.env.AUX_WORKSPACE_ROOT = TMP_DIR;

function setupFixtures() {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, "sample.txt"), "Hello world\nTest content\n");
}

function cleanup() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  if (savedKey) process.env.AUX_MODEL_API_KEY = savedKey;
  else delete process.env.AUX_MODEL_API_KEY;
}

// ── Tests ────────────────────────────────────────────────────

describe("MCP Tool Feedback Loop — Step 0 Red Light Tests", () => {
  before(setupFixtures);
  after(cleanup);

  let handleCompressText: Function;
  let validateInput: Function;

  before(async () => {
    const modCt = await import("../src/tools/compress-text.js");
    handleCompressText = modCt.handleCompressText;
    const modSchema = await import("../src/schema.js");
    validateInput = modSchema.validateInput;
  });

  // ═══════════════════════════════════════════════════════════
  // Fixture A: trace_id / tool_name 暴露
  // ═══════════════════════════════════════════════════════════
  // 预期失败：当前输出 _meta 中没有 trace_id 和 tool_name 字段。

  describe("Fixture A: _meta.trace_id and _meta.tool_name", () => {
    it("should expose _meta.trace_id in tool output", async () => {
      const result = await handleCompressText(
        { label: "test-label", text: "Hello world", max_chars: 1000 },
        { workspaceRoot: TMP_DIR },
      );

      assert.equal(result.isError, false);
      const json = JSON.parse(result.content[0].text as string);

      // RED LIGHT: _meta.trace_id does not exist in current output
      assert.equal(typeof json._meta.trace_id, "string");
    });

    it("should expose _meta.tool_name matching called tool", async () => {
      const result = await handleCompressText(
        { label: "test-label", text: "Hello world", max_chars: 1000 },
        { workspaceRoot: TMP_DIR },
      );

      assert.equal(result.isError, false);
      const json = JSON.parse(result.content[0].text as string);

      // RED LIGHT: _meta.tool_name does not exist in current output
      assert.equal(json._meta.tool_name, "aux_compress_text");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Fixture B: 反馈工具存在性
  // ═══════════════════════════════════════════════════════════
  // 预期失败：当前没有 aux_report_tool_feedback 工具和 handler。

  describe("Fixture B: aux_report_tool_feedback is registered", () => {
    it("should have aux_report_tool_feedback in schema registry", () => {
      // RED LIGHT: validateInput returns "Unknown tool" because the tool
      // is not in inputSchemas
      const result = validateInput("aux_report_tool_feedback", {
        tool_name: "aux_compress_text",
        issue_category: "wrong_kind",
        severity: "medium",
        summary: "Test feedback summary",
        confidence: "high",
      });

      assert.ok(result.ok, "aux_report_tool_feedback should be a registered tool");
    });

    it("should export handleReportToolFeedback handler", async () => {
      // RED LIGHT: this import throws MODULE_NOT_FOUND because the module
      // does not exist yet
      const mod = await import("../src/tools/report-tool-feedback.js");
      assert.equal(typeof mod.handleReportToolFeedback, "function");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Fixture C: 隐私和长度限制
  // ═══════════════════════════════════════════════════════════
  // 预期失败：当前没有 ToolFeedbackInput schema 和 sanitizer，
  //           所以 validateInput 返回的是 "Unknown tool" 而非字段级别的校验错误。

  describe("Fixture C: schema rejects oversized/sensitive feedback", () => {
    it("should reject summary longer than 500 chars", () => {
      const result = validateInput("aux_report_tool_feedback", {
        tool_name: "test",
        issue_category: "wrong_kind",
        severity: "low",
        summary: "x".repeat(501),
        confidence: "low",
      });

      // RED LIGHT: error is "Unknown tool: aux_report_tool_feedback",
      // not a length-related validation error
      assert.match(result.error || "", /summary|too_big|length/i);
    });

    it("should reject evidence longer than 1000 chars", () => {
      const result = validateInput("aux_report_tool_feedback", {
        tool_name: "test",
        issue_category: "wrong_kind",
        severity: "low",
        summary: "short summary",
        evidence: "x".repeat(1001),
        confidence: "low",
      });

      // RED LIGHT: error is "Unknown tool: aux_report_tool_feedback",
      // not a length-related validation error
      assert.match(result.error || "", /evidence|too_big|length/i);
    });

    it("should reject sk- API key patterns", () => {
      const result = validateInput("aux_report_tool_feedback", {
        tool_name: "test",
        issue_category: "wrong_kind",
        severity: "low",
        summary: "summary",
        evidence: "My key is sk-abc123def456",
        confidence: "low",
      });

      // RED LIGHT: error is "Unknown tool: aux_report_tool_feedback",
      // not a sensitive-data rejection
      assert.match(result.error || "", /api\.key|sensitive|sk-/i);
    });

    it("should reject Authorization header patterns", () => {
      const result = validateInput("aux_report_tool_feedback", {
        tool_name: "test",
        issue_category: "wrong_kind",
        severity: "low",
        summary: "summary",
        evidence: "Authorization: Bearer my-token-here",
        confidence: "low",
      });

      // RED LIGHT: error is "Unknown tool: aux_report_tool_feedback",
      // not a sensitive-data rejection
      assert.match(result.error || "", /sensitive|Authorization|Bearer/i);
    });
  });
});
