import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewDiffByFileFallback } from "../src/fallback/review-diff-by-file.js";

describe("reviewDiffByFileFallback", () => {
  it("produces findings with file and evidence for hardcoded secret", () => {
    const diff = [
      "--- a/src/auth.ts\n+++ b/src/auth.ts",
      "@@ -1,3 +1,4 @@",
      "+const password = 'hardcoded123'",
    ].join("\n");
    const result = reviewDiffByFileFallback(diff);
    assert.ok(result.files.length > 0, "Should have at least one file review");
    const finding = result.files[0].findings[0];
    assert.ok(finding, "Should have at least one finding");
    assert.ok(finding.file, "Finding should have file field");
    assert.ok(finding.evidence, "Finding should have evidence field");
  });

  it("handles empty diff gracefully", () => {
    const result = reviewDiffByFileFallback("");
    assert.equal(result.files.length, 0);
    assert.equal(result.overall_summary, "No changes detected");
  });

  it("detects auth removal", () => {
    const diff = [
      "--- a/src/auth.ts\n+++ b/src/auth.ts",
      "@@ -1,3 +1,1 @@",
      "-function authenticate(user) {",
      "-  return verifyToken(user.token);",
      "-}",
    ].join("\n");
    const result = reviewDiffByFileFallback(diff);
    const allFindings = result.files.flatMap(f => f.findings);
    const authFinding = allFindings.find(f => f.risk.includes("Auth-related"));
    assert.ok(authFinding, "Should detect auth-related code removal");
  });

  it("includes omitted_files in result", () => {
    const result = reviewDiffByFileFallback("--- a/icon.png\n+++ b/icon.png\n@@ -1,1 +1,1 @@");
    assert.ok(result.omitted_files.length >= 0, "omitted_files should be an array");
  });

  it("detects empty catch blocks", () => {
    const diff = [
      "--- a/src/handler.ts\n+++ b/src/handler.ts",
      "@@ -1,1 +1,5 @@",
      "+try {",
      "+  doThing();",
      "+} catch (e) {",
      "+}",
    ].join("\n");
    const result = reviewDiffByFileFallback(diff);
    const allFindings = result.files.flatMap(f => f.findings);
    const catchFinding = allFindings.find(f => f.risk.includes("Empty catch"));
    assert.ok(catchFinding, "Should detect empty catch blocks");
  });

  it("detects command execution with user input", () => {
    const diff = [
      "--- a/src/api.ts\n+++ b/src/api.ts",
      "@@ -1,1 +1,2 @@",
      "+exec(req.body.command)",
    ].join("\n");
    const result = reviewDiffByFileFallback(diff);
    const allFindings = result.files.flatMap(f => f.findings);
    const cmdFinding = allFindings.find(f => f.risk.includes("Command execution"));
    assert.ok(cmdFinding, "Should detect command execution");
    assert.ok(cmdFinding.severity === "critical", "Command exec with user input should be critical");
  });

  it("detects debug output left in code", () => {
    const diff = [
      "--- a/src/lib.ts\n+++ b/src/lib.ts",
      "@@ -1,1 +1,2 @@",
      "+console.log('debug:', value)",
    ].join("\n");
    const result = reviewDiffByFileFallback(diff);
    const allFindings = result.files.flatMap(f => f.findings);
    const debugFinding = allFindings.find(f => f.risk.includes("Debug output"));
    assert.ok(debugFinding, "Should detect console.log");
  });

  it("includes top_risks sorted by severity", () => {
    const diff = [
      "--- a/src/a.ts\n+++ b/src/a.ts",
      "@@ -1,1 +1,3 @@",
      "+const password = 'secret'",
      "+console.log('debug')",
    ].join("\n");
    const result = reviewDiffByFileFallback(diff);
    assert.ok(result.top_risks.length > 0, "Should have top risks");
    // Critical risks should come before medium risks
    const criticalIdx = result.top_risks.findIndex(r => r.severity === "critical");
    const mediumIdx = result.top_risks.findIndex(r => r.severity === "medium");
    if (criticalIdx >= 0 && mediumIdx >= 0) {
      assert.ok(criticalIdx < mediumIdx, "Critical should come before medium");
    }
  });

  it("has _meta with chunking info", () => {
    const diff = [
      "--- a/src/a.ts\n+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      "+new line",
    ].join("\n");
    const result = reviewDiffByFileFallback(diff);
    assert.ok(result._meta.chunking, "Should have chunking metadata");
    assert.ok(result._meta.chunking.chunking_strategy.length > 0);
    assert.equal(result.is_authoritative, false);
  });
});
