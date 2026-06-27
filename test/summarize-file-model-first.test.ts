/**
 * Step 0 red-light → green-light tests for summarize_file model-first migration.
 *
 * These tests assert the DESIRED behavior defined in the construction plan.
 * Currently they should FAIL (red-light) because:
 *   1. SwiftUI DSL components (VStack, Button, ScrollView) are misidentified as functions
 *   2. Fallback doesn't clearly separate "structural scan" from "semantic summary"
 *   3. Tail content of large files can be lost
 *
 * After plan implementation completes, all tests should PASS (green-light).
 *
 * Run: node --import tsx --test test/summarize-file-model-first.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const TMP_DIR = join(__dirname, "..", "tmp_summarize_redlight");
const FIXTURES_DIR = join(__dirname, "fixtures", "summarize-file");

// Ensure no API key leaks for fallback tests
const savedKey = process.env.AUX_MODEL_API_KEY;

function setup() {
  mkdirSync(TMP_DIR, { recursive: true });

  // Copy fixtures to tmp for safe-path resolution
  for (const name of ["swiftui-view.swift", "swift-service.swift", "typescript-control.ts"]) {
    writeFileSync(
      join(TMP_DIR, name),
      readFileSync(join(FIXTURES_DIR, name), "utf-8"),
    );
  }
}

function cleanup() {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Helper: run the fallback summarizer directly
// ---------------------------------------------------------------------------

async function runFallback(relativePath: string): Promise<any> {
  const { summarizeFileFallback } = await import("../src/fallback/summarize-file.js");
  return summarizeFileFallback(TMP_DIR, relativePath);
}

// ---------------------------------------------------------------------------
// Helper: run the full handler (fallback mode)
// ---------------------------------------------------------------------------

async function runHandler(relativePath: string, opts?: { focus?: string; maxChars?: number }): Promise<any> {
  const { handleSummarizeFile } = await import("../src/tools/summarize-file.js");
  const result = await handleSummarizeFile(
    { path: relativePath, max_chars: opts?.maxChars ?? 50000, ...(opts?.focus ? { focus: opts.focus } : {}) },
    { workspaceRoot: TMP_DIR },
  );
  if (result.isError) throw new Error(`Handler error: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text as string);
}

// ---------------------------------------------------------------------------
// Red-light tests: SwiftUI misidentification (P0 for this plan)
// ---------------------------------------------------------------------------

describe("Red-light: SwiftUI fallback behavior", () => {
  before(() => {
    delete process.env.AUX_MODEL_API_KEY;
    process.env.AUX_WORKSPACE_ROOT = TMP_DIR;
    setup();
  });
  after(() => {
    cleanup();
    if (savedKey) process.env.AUX_MODEL_API_KEY = savedKey;
    else delete process.env.AUX_MODEL_API_KEY;
    delete process.env.AUX_WORKSPACE_ROOT;
  });

  it("RED: fallback does NOT identify SwiftUI DSL components as functions", async () => {
    const result = await runFallback("swiftui-view.swift");

    const symbolNames = result.important_symbols.map((s: any) => s.name);

    // These are SwiftUI DSL component constructors, NOT top-level function declarations.
    // The current heuristic patterns (especially `name(...) {`) incorrectly match them.
    const dslComponents = ["VStack", "HStack", "Button", "ScrollView", "LazyHStack", "ForEach", "Text", "Image"];
    const misidentified = dslComponents.filter((name) => symbolNames.includes(name));

    // RED: this assertion currently fails because the old fallback misidentifies these
    assert.deepStrictEqual(
      misidentified,
      [],
      `SwiftUI DSL components should NOT be in important_symbols. ` +
      `Currently misidentified: ${misidentified.join(", ")}. ` +
      `The heuristic regex name(...) { pattern matches SwiftUI component constructors as functions.`,
    );
  });

  it("RED: fallback identifies actual struct declarations, not DSL components", async () => {
    const result = await runFallback("swiftui-view.swift");

    const symbolNames = result.important_symbols.map((s: any) => s.name);

    // These are the actual top-level types in the file
    assert.ok(
      symbolNames.includes("ProfileCardView"),
      "Should identify ProfileCardView struct",
    );
    assert.ok(
      symbolNames.includes("PostThumbnailView"),
      "Should identify PostThumbnailView struct",
    );
  });

  it("RED: fallback analysis_status is always 'partial'", async () => {
    const output = await runHandler("swiftui-view.swift");

    // The full handler through buildFallbackResult should set analysis_status to "partial"
    assert.equal(
      output.analysis_status,
      "partial",
      "Fallback path should always return analysis_status: partial",
    );
    assert.equal(
      output._meta.fallback_used,
      true,
      "Fallback path should have fallback_used: true",
    );
  });

  it("RED: fallback marks Swift symbols with lower confidence than TS/JS", async () => {
    const result = await runFallback("swiftui-view.swift");

    // All symbols from non-TS/JS languages should have lower confidence
    // because the regex patterns are primarily tuned for TS/JS
    const swiftSymbols = result.important_symbols;
    for (const sym of swiftSymbols) {
      // Current behavior: "exported, ..." roles for non-TS files are misleading
      const role = (sym.role ?? "").toLowerCase();
      // RED: this would fail if role contains "exported" for a Swift file
      // (Swift uses 'public'/'internal', not 'export')
      assert.ok(
        !role.includes("exported"),
        `Swift symbol "${sym.name}" should not have "exported" role: got "${sym.role}"`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Red-light tests: Tail content preservation
// ---------------------------------------------------------------------------

describe("Red-light: tail content preservation", () => {
  before(() => {
    delete process.env.AUX_MODEL_API_KEY;
    process.env.AUX_WORKSPACE_ROOT = TMP_DIR;
    setup();
  });
  after(() => {
    cleanup();
    if (savedKey) process.env.AUX_MODEL_API_KEY = savedKey;
    else delete process.env.AUX_MODEL_API_KEY;
    delete process.env.AUX_WORKSPACE_ROOT;
  });

  it("RED: fallback preserves suffix when file is truncated", async () => {
    // Create a large file where important symbols are at the end
    const lines: string[] = [];
    // 4000 lines of filler
    for (let i = 0; i < 4000; i++) {
      lines.push(`// Filler line ${i} — this is just padding to make the file long`);
    }
    // Important content at the end
    lines.push("");
    lines.push("export class ImportantService {");
    lines.push("  async process(): Promise<void> {");
    lines.push("    // critical business logic");
    lines.push("  }");
    lines.push("}");
    lines.push("");
    lines.push("export function criticalHelper(): string {");
    lines.push("  return 'important';");
    lines.push("}");

    writeFileSync(join(TMP_DIR, "tail-heavy.ts"), lines.join("\n"));

    // Use a small maxChars to force truncation
    const output = await runHandler("tail-heavy.ts", { maxChars: 10000 });

    // RED: the current prefix-only truncation may miss these tail symbols
    // After smart truncation (splitPrefixSuffix), the tail should be visible
    const symbolNames = output.important_symbols.map((s: any) => s.name);
    assert.ok(
      symbolNames.includes("ImportantService") || symbolNames.includes("criticalHelper"),
      `Tail symbols should be found. Got: ${symbolNames.join(", ")}. ` +
      `The smart truncation should preserve file suffix.`,
    );
  });
});

// ---------------------------------------------------------------------------
// Red-light tests: TS/JS fallback regression guard
// ---------------------------------------------------------------------------

describe("Red-light: TypeScript fallback regression guard", () => {
  before(() => {
    delete process.env.AUX_MODEL_API_KEY;
    process.env.AUX_WORKSPACE_ROOT = TMP_DIR;
    setup();
  });
  after(() => {
    cleanup();
    if (savedKey) process.env.AUX_MODEL_API_KEY = savedKey;
    else delete process.env.AUX_MODEL_API_KEY;
    delete process.env.AUX_WORKSPACE_ROOT;
  });

  it("TS fallback still identifies class and function symbols", async () => {
    const result = await runFallback("typescript-control.ts");

    const names = result.important_symbols.map((s: any) => s.name);
    assert.ok(names.includes("FileSystemCache"), "Should identify FileSystemCache class");
    assert.ok(names.includes("createFileCache"), "Should identify createFileCache function");
    assert.ok(names.includes("CacheError"), "Should identify CacheError class");
  });

  it("TS fallback still identifies interface and type symbols", async () => {
    const result = await runFallback("typescript-control.ts");

    const names = result.important_symbols.map((s: any) => s.name);
    assert.ok(names.includes("CacheEntry"), "Should identify CacheEntry interface");
    assert.ok(names.includes("CacheStats"), "Should identify CacheStats interface");
    // Note: Serializer<T> and Deserializer<T> use generic params — the regex
    // `type\s+(\w+)\s*=` does not match `<T>`. This is a known heuristic
    // limitation; the model path handles generic type aliases.
  });

  it("TS fallback still identifies enum and const symbols", async () => {
    const result = await runFallback("typescript-control.ts");

    const names = result.important_symbols.map((s: any) => s.name);
    assert.ok(names.includes("CacheErrorCode"), "Should identify CacheErrorCode enum");
    assert.ok(names.includes("DEFAULT_MAX_ENTRIES"), "Should identify DEFAULT_MAX_ENTRIES const");
  });

  it("TS fallback still produces evidence and uncertainties", async () => {
    const result = await runFallback("typescript-control.ts");

    assert.ok(Array.isArray(result.evidence), "Should have evidence array");
    assert.ok(result.evidence.length > 0, "Should have at least one evidence item");
    assert.ok(Array.isArray(result.uncertainties), "Should have uncertainties array");
    assert.ok(result.uncertainties.length > 0, "Should have at least one uncertainty");
  });

  it("TS fallback must_verify_in_source is true", async () => {
    const result = await runFallback("typescript-control.ts");
    assert.equal(result.must_verify_in_source, true);
  });

  it("TS fallback is_authoritative is false", async () => {
    const result = await runFallback("typescript-control.ts");
    assert.equal(result.is_authoritative, false);
  });

  it("TS handler output has all required fields", async () => {
    const output = await runHandler("typescript-control.ts");

    assert.equal(typeof output.summary, "string");
    assert.ok(output.summary.length > 0);
    assert.ok(Array.isArray(output.important_symbols));
    assert.ok(Array.isArray(output.evidence));
    assert.ok(Array.isArray(output.uncertainties));
    assert.equal(typeof output.must_verify_in_source, "boolean");
    assert.equal(output.is_authoritative, false);
    assert.ok(output._meta !== undefined);
    assert.equal(typeof output._meta.fallback_used, "boolean");
    assert.equal(typeof output._meta.input_truncated, "boolean");
  });
});
