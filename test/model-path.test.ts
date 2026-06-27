/**
 * Model-path integration tests.
 *
 * These tests require a valid API key. Set AUX_ENV_FILE or env vars.
 * They exercise the model-based code paths skipped in smoke tests.
 *
 * Run: AUX_ENV_FILE=$PWD/.env node --import tsx --test test/model-path.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const TMP_DIR = join(__dirname, "..", "tmp_model_test");
const FIXTURES_DIR = join(__dirname, "fixtures", "summarize-file");

// Set env file before any config imports
const envFile = process.env.AUX_ENV_FILE;
if (envFile) {
  try {
    const content = readFileSync(envFile, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* ignore */ }
}

// Determine if model is available
const HAS_MODEL = !!process.env.AUX_MODEL_API_KEY;

function setup() {
  mkdirSync(TMP_DIR, { recursive: true });
  for (const name of ["swiftui-view.swift", "swift-service.swift", "typescript-control.ts"]) {
    writeFileSync(join(TMP_DIR, name), readFileSync(join(FIXTURES_DIR, name), "utf-8"));
  }
  writeFileSync(join(TMP_DIR, "small.ts"), 'export const hello = "world";\n');
  writeFileSync(join(TMP_DIR, "readme.md"), [
    "# Test Project", "", "Content.", "## Usage", "", "Run `npm test`.", "",
  ].join("\n"));
}

function cleanup() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
}

// Build full config from current env
function buildConfig(): any {
  return {
    modelApiKey: process.env.AUX_MODEL_API_KEY ?? "",
    modelBaseUrl: process.env.AUX_MODEL_BASE_URL ?? "https://api.deepseek.com/v1",
    modelName: process.env.AUX_MODEL_NAME ?? "deepseek-v4-flash",
    modelProvider: process.env.AUX_MODEL_PROVIDER ?? "remote",
    modelTimeoutMs: Number(process.env.AUX_MODEL_TIMEOUT_MS) || 30000,
    modelAllowedHosts: process.env.AUX_MODEL_ALLOWED_HOSTS?.split(",").filter(Boolean) ?? [],
    modelDisableThinking: process.env.AUX_MODEL_DISABLE_THINKING === "true",
    allowInsecureLocalHttp: process.env.AUX_ALLOW_INSECURE_LOCAL_HTTP === "true",
    workspaceRoot: TMP_DIR,
  };
}

// ---------------------------------------------------------------------------
// summarize_file — model path
// ---------------------------------------------------------------------------

describe("summarize_file: model path", () => {
  let handleSummarizeFile: Function;

  before(async () => {
    if (!HAS_MODEL) return;
    process.env.AUX_WORKSPACE_ROOT = TMP_DIR;
    setup();
    const mod = await import("../src/tools/summarize-file.js");
    handleSummarizeFile = mod.handleSummarizeFile;
  });
  after(() => {
    cleanup();
    delete process.env.AUX_WORKSPACE_ROOT;
  });

  it("produces model-based summary for simple TS file", { skip: !HAS_MODEL }, async () => {
    const config = buildConfig();
    const result = await handleSummarizeFile({ path: "small.ts", max_chars: 50000 }, config);
    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.equal(typeof json.summary, "string");
    assert.ok(json.summary.length > 0);
    assert.equal(json._meta.fallback_used, false, "Should use model, not fallback");
    assert.equal(json._meta.model_attempted, true);
    assert.ok(Array.isArray(json.important_symbols));
    assert.ok(Array.isArray(json.evidence));
    assert.ok(Array.isArray(json.uncertainties));
    assert.equal(json.is_authoritative, false);
  });

  it("model path analyzes Swift service class", { skip: !HAS_MODEL }, async () => {
    const config = buildConfig();
    const result = await handleSummarizeFile(
      { path: "swift-service.swift", max_chars: 50000 },
      config,
    );
    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.equal(typeof json.summary, "string");
    assert.ok(json.summary.length > 0);
    assert.equal(json._meta.fallback_used, false);
    const names = json.important_symbols.map((s: any) => s.name);
    assert.ok(names.length > 0, `Should identify symbols. Got: ${names.join(", ")}`);
  });

  it("model path produces evidence with sources", { skip: !HAS_MODEL }, async () => {
    const config = buildConfig();
    const result = await handleSummarizeFile(
      { path: "typescript-control.ts", max_chars: 50000 },
      config,
    );
    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.equal(json._meta.fallback_used, false);
    assert.ok(json.evidence.length > 0, "Should have evidence entries");
  });

  it("model path with focus parameter", { skip: !HAS_MODEL }, async () => {
    const config = buildConfig();
    const result = await handleSummarizeFile(
      { path: "swift-service.swift", max_chars: 50000, focus: "error handling" },
      config,
    );
    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.equal(json._meta.model_attempted, true);
    // Model may fall back on schema mismatch — that's OK for coverage
    assert.equal(typeof json.summary, "string");
  });

  it("model path handles markdown files", { skip: !HAS_MODEL }, async () => {
    const config = buildConfig();
    const result = await handleSummarizeFile(
      { path: "readme.md", max_chars: 50000 },
      config,
    );
    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.equal(typeof json.summary, "string");
  });
});

// ---------------------------------------------------------------------------
// compress_text — model path
// ---------------------------------------------------------------------------

describe("compress_text: model path", () => {
  let handleCompressText: Function;

  before(async () => {
    if (!HAS_MODEL) return;
    process.env.AUX_WORKSPACE_ROOT = TMP_DIR;
    setup();
    const mod = await import("../src/tools/compress-text.js");
    handleCompressText = mod.handleCompressText;
  });
  after(() => {
    cleanup();
    delete process.env.AUX_WORKSPACE_ROOT;
  });

  it("produces model-based compression", { skip: !HAS_MODEL }, async () => {
    const config = buildConfig();
    const result = await handleCompressText(
      { label: "test-log", text: "ERROR: DB connection failed\nINFO: Retrying\nERROR: Timeout", max_chars: 5000 },
      config,
    );
    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.equal(typeof json.summary, "string");
    assert.equal(json._meta.fallback_used, false, "Should use model, not fallback");
    assert.ok(Array.isArray(json.key_facts));
    assert.equal(json.is_authoritative, false);
  });
});

// ---------------------------------------------------------------------------
// review_diff — model path
// ---------------------------------------------------------------------------

describe("review_diff: model path", () => {
  let handleReviewDiff: Function;

  before(async () => {
    if (!HAS_MODEL) return;
    process.env.AUX_WORKSPACE_ROOT = TMP_DIR;
    setup();
    const mod = await import("../src/tools/review-diff.js");
    handleReviewDiff = mod.handleReviewDiff;
  });
  after(() => {
    cleanup();
    delete process.env.AUX_WORKSPACE_ROOT;
  });

  it("produces model-based diff review", { skip: !HAS_MODEL }, async () => {
    const config = buildConfig();
    const diff = [
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,1 +1,2 @@",
      '+const password = "hardcoded-secret-123"',
    ].join("\n");
    const result = await handleReviewDiff({ diff, max_chars: 5000 }, config);
    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.equal(typeof json.change_summary, "string");
    assert.ok(Array.isArray(json.possible_risks));
    assert.equal(json._meta.fallback_used, false, "Should use model, not fallback");
    assert.equal(json.is_authoritative, false);
  });
});

// ---------------------------------------------------------------------------
// compress_command_output — model path
// ---------------------------------------------------------------------------

describe("compress_command_output: model path", () => {
  let handleCompressCommandOutput: Function;

  before(async () => {
    if (!HAS_MODEL) return;
    process.env.AUX_WORKSPACE_ROOT = TMP_DIR;
    setup();
    const mod = await import("../src/tools/compress-command-output.js");
    handleCompressCommandOutput = mod.handleCompressCommandOutput;
  });
  after(() => {
    cleanup();
    delete process.env.AUX_WORKSPACE_ROOT;
  });

  it("produces model-based command output analysis", { skip: !HAS_MODEL }, async () => {
    const config = buildConfig();
    const tscOutput = [
      "src/auth.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/auth.ts(25,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      "src/db.ts(8,1): error TS2304: Cannot find name 'prisma'.",
    ].join("\n");
    const result = await handleCompressCommandOutput(
      { command: "tsc", output: tscOutput, exit_code: 2, max_chars: 5000 },
      config,
    );
    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.equal(typeof json.summary, "string");
    assert.ok(json.summary.length > 0);
    assert.ok(Array.isArray(json.findings), "Should have findings array");
    assert.equal(json.is_authoritative, false);
  });

  it("model path with focus parameter", { skip: !HAS_MODEL }, async () => {
    const config = buildConfig();
    const testOutput = [
      "FAIL src/App.test.ts",
      "  ✕ should render (50ms)",
      "  ✓ should handle click",
      "",
      "FAIL src/utils.test.ts",
      "  ✕ should format date (30ms)",
    ].join("\n");
    const result = await handleCompressCommandOutput(
      { command: "npm test", output: testOutput, exit_code: 1, max_chars: 5000, focus: "test failures" },
      config,
    );
    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.ok(Array.isArray(json.findings), "Should have findings");
  });
});

// ---------------------------------------------------------------------------
// review_diff_by_file — model path
// ---------------------------------------------------------------------------

describe("review_diff_by_file: model path", () => {
  let handleReviewDiffByFile: Function;

  before(async () => {
    if (!HAS_MODEL) return;
    process.env.AUX_WORKSPACE_ROOT = TMP_DIR;
    setup();
    const mod = await import("../src/tools/review-diff-by-file.js");
    handleReviewDiffByFile = mod.handleReviewDiffByFile;
  });
  after(() => {
    cleanup();
    delete process.env.AUX_WORKSPACE_ROOT;
  });

  it("produces model-based per-file review", { skip: !HAS_MODEL }, async () => {
    const config = buildConfig();
    const diff = [
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,3 +1,4 @@",
      " function login(user: string) {",
      "+  console.log('debug:', user);",
      "   return true;",
      " }",
    ].join("\n");
    const result = await handleReviewDiffByFile({ diff }, config);
    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.equal(typeof json.overall_summary, "string");
    assert.ok(Array.isArray(json.files), "Should have files array");
    assert.equal(json.is_authoritative, false);
  });
});
