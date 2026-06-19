/**
 * Smoke tests — 不依赖 AUX_MODEL_API_KEY，验证 fallback 模式下的核心链路。
 *
 * 运行: npm run smoke
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const TMP_DIR = join(__dirname, "..", "tmp_smoke_test");

// Ensure no API key leaks from environment
const savedKey = process.env.AUX_MODEL_API_KEY;
delete process.env.AUX_MODEL_API_KEY;
process.env.AUX_WORKSPACE_ROOT = TMP_DIR;

// Import after env setup (lazy evaluation of env vars)
async function setupFixtures() {
  mkdirSync(TMP_DIR, { recursive: true });

  // Create a sample TypeScript file
  writeFileSync(
    join(TMP_DIR, "example.ts"),
    [
      'import { readFileSync } from "node:fs";',
      "",
      "/** Say hello */",
      "export function greet(name: string): string {",
      '  return `Hello, ${name}!`;',
      "}",
      "",
      "export class Greeter {",
      "  private prefix: string;",
      "",
      "  constructor(prefix: string) {",
      "    this.prefix = prefix;",
      "  }",
      "",
      "  greet(name: string): string {",
      "    return `${this.prefix}, ${name}!`;",
      "  }",
      "}",
      "",
      "const DEFAULT_NAME = 'World';",
      "",
      "export default function main() {",
      "  console.log(greet(DEFAULT_NAME));",
      "}",
    ].join("\n"),
  );

  // Create a sample markdown file
  writeFileSync(
    join(TMP_DIR, "readme.md"),
    "# Test Project\n\nThis is a test project for smoke testing.\n\n## Usage\n\nRun `npm test`.\n",
  );
}

function cleanupFixtures() {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
  // Restore API key
  if (savedKey) {
    process.env.AUX_MODEL_API_KEY = savedKey;
  } else {
    delete process.env.AUX_MODEL_API_KEY;
  }
}

describe("Smoke tests (no API key, fallback mode)", () => {
  before(setupFixtures);
  after(cleanupFixtures);

  // Dynamic imports to get modules after env setup
  let handleSummarizeFile: Function;
  let handleCompressText: Function;
  let handleReviewDiff: Function;

  before(async () => {
    const mod_sf = await import("../src/tools/summarize-file.js");
    handleSummarizeFile = mod_sf.handleSummarizeFile;
    const mod_ct = await import("../src/tools/compress-text.js");
    handleCompressText = mod_ct.handleCompressText;
    const mod_rd = await import("../src/tools/review-diff.js");
    handleReviewDiff = mod_rd.handleReviewDiff;
  });

  it("aux_summarize_file produces structured fallback output", async () => {
    const result = await handleSummarizeFile(
      { path: "example.ts", max_chars: 5000 },
      { workspaceRoot: TMP_DIR },
    );

    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);

    assert.equal(typeof json.summary, "string");
    assert.ok(json.summary.length > 0, "summary should not be empty");
    assert.ok(Array.isArray(json.important_symbols), "important_symbols should be an array");
    assert.ok(json.important_symbols.length > 0, "should find at least one symbol");
    assert.equal(json.is_authoritative, false);
    assert.equal(json.must_verify_in_source, true);
    assert.equal(json._meta.fallback_used, true);
    assert.equal(json._meta.model, "heuristic");

    // Should find Greeter class and greet function
    const names = json.important_symbols.map((s: any) => s.name);
    assert.ok(names.includes("Greeter"), "should find Greeter class");
    assert.ok(names.includes("greet"), "should find greet function");

    // Should have uncertainties
    assert.ok(Array.isArray(json.uncertainties));
    assert.ok(json.uncertainties.length > 0, "should have uncertainties");
  });

  it("aux_summarize_file handles markdown files", async () => {
    const result = await handleSummarizeFile(
      { path: "readme.md" },
      { workspaceRoot: TMP_DIR },
    );

    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.equal(typeof json.summary, "string");
    assert.ok(json.summary.includes("readme.md"), "summary should mention filename");
  });

  it("aux_summarize_file rejects path traversal", async () => {
    const result = await handleSummarizeFile(
      { path: "../../../etc/passwd" },
      { workspaceRoot: TMP_DIR },
    );

    assert.equal(result.isError, true);
    const text = result.content[0].text as string;
    assert.ok(
      text.toLowerCase().includes("access denied") ||
        text.toLowerCase().includes("rejected") ||
        text.toLowerCase().includes("outside"),
      `expected access denied message, got: ${text}`,
    );
  });

  it("aux_summarize_file rejects absolute paths", async () => {
    const result = await handleSummarizeFile(
      { path: "C:\\Windows\\System32\\config\\sam" },
      { workspaceRoot: TMP_DIR },
    );

    assert.equal(result.isError, true);
  });

  it("aux_summarize_file returns error for nonexistent file", async () => {
    const result = await handleSummarizeFile(
      { path: "nonexistent.ts" },
      { workspaceRoot: TMP_DIR },
    );

    assert.equal(result.isError, true);
    assert.ok(
      (result.content[0].text as string).toLowerCase().includes("not found"),
    );
  });

  it("aux_compress_text produces structured fallback output", async () => {
    const logText = [
      "INFO: Server started on port 3000",
      "ERROR: Connection refused to database",
      "WARN: Deprecated API endpoint used",
      "FATAL: Out of memory in worker process",
      "INFO: Retrying in 5 seconds...",
      "ERROR: Timeout exceeded for request #12345",
    ].join("\n");

    const result = await handleCompressText(
      { label: "test-log", text: logText, max_chars: 10000 },
      { workspaceRoot: TMP_DIR },
    );

    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);

    assert.equal(typeof json.summary, "string");
    assert.ok(json.summary.includes("test-log"), "summary should include label");
    assert.ok(Array.isArray(json.key_facts), "key_facts should be an array");
    assert.equal(json.is_authoritative, false);
    assert.equal(json.must_verify_in_source, true);
    assert.equal(json._meta.fallback_used, true);

    // Should detect ERROR keywords
    const factText = json.key_facts.join(" ");
    assert.ok(
      factText.includes("ERROR") || factText.includes("error"),
      "should capture ERROR lines",
    );
  });

  it("aux_compress_text handles minimal text", async () => {
    const result = await handleCompressText(
      { label: "minimal", text: "OK", max_chars: 1000 },
      { workspaceRoot: TMP_DIR },
    );

    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);
    assert.equal(typeof json.summary, "string");
  });

  it("aux_review_diff detects high-risk patterns in fallback mode", async () => {
    const diff = [
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -10,7 +10,8 @@",
      " function login(username: string, password: string) {",
      "-  const token = getToken(username, password);",
      '+  const token = "hardcoded-secret-12345";',
      "+  eval(`validate(${username})`);",
      "   return token;",
      " }",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -5,3 +5,4 @@",
      '   "dependencies": {',
      '+    "malicious-pkg": "^1.0.0"',
      "   }",
    ].join("\n");

    const result = await handleReviewDiff(
      { diff, max_chars: 5000 },
      { workspaceRoot: TMP_DIR },
    );

    assert.equal(result.isError, false);
    const json = JSON.parse(result.content[0].text as string);

    assert.equal(typeof json.change_summary, "string");
    assert.ok(json.change_summary.length > 0, "change_summary should not be empty");
    assert.ok(Array.isArray(json.possible_risks), "possible_risks should be an array");
    assert.equal(json.is_authoritative, false);
    assert.equal(json._meta.fallback_used, true);

    // Should detect at least the dependency change and some risk patterns
    const riskText = JSON.stringify(json.possible_risks).toLowerCase();
    const riskSeverities = json.possible_risks.map((r: any) => r.severity);
    assert.ok(
      riskText.includes("secret") ||
        riskText.includes("hardcoded") ||
        riskText.includes("password") ||
        riskText.includes("token") ||
        riskText.includes("eval") ||
        riskText.includes("inject") ||
        riskText.includes("dependency") ||
        riskText.includes("manifest") ||
        json.possible_risks.length > 0,
      `should detect at least one risk pattern, got ${json.possible_risks.length} risks: ${JSON.stringify(json.possible_risks)}`,
    );

    // Should have suggested source checks
    assert.ok(Array.isArray(json.suggested_source_checks));
    assert.ok(json.suggested_source_checks.length > 0, "should suggest source checks");

    // Should have uncertainties
    assert.ok(Array.isArray(json.uncertainties));
  });

  it("aux_review_diff rejects empty diff (schema requires min 1 char)", async () => {
    const result = await handleReviewDiff(
      { diff: "" },
      { workspaceRoot: TMP_DIR },
    );

    // Empty diff fails input schema validation (diff requires min 1 char)
    assert.equal(result.isError, true);
  });

  it("aux_compress_text rejects invalid input (missing required field)", async () => {
    const result = await handleCompressText(
      { text: "some text" }, // missing 'label'
      { workspaceRoot: TMP_DIR },
    );

    assert.equal(result.isError, true);
  });
});
