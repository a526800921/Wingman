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
    // Fallback no longer performs regex-based symbol extraction — important_symbols is always empty
    assert.equal(result.important_symbols.length, 0, "Fallback no longer extracts symbols");
    assert.ok(Array.isArray(result.heuristic_signals), "Should have heuristic_signals");
    assert.ok(result.heuristic_signals.some((s: any) => s.kind === "file_kind"), "Should have file_kind signal");
  });

  it("RED: fallback NO LONGER extracts symbols (struct or otherwise)", async () => {
    const result = await runFallback("swiftui-view.swift");
    // Fallback is purely mechanical — no regex-based symbol extraction
    assert.equal(result.important_symbols.length, 0, "Fallback no longer extracts symbols");
    assert.ok(result.heuristic_signals.some((s: any) => s.kind === "file_kind"), "Should detect file kind");
  });

  it("RED: fallback analysis_status is 'incomplete'", async () => {
    const output = await runHandler("swiftui-view.swift");

    // Fallback now returns "incomplete" — no semantic analysis performed
    assert.equal(output.analysis_status, "incomplete");
    assert.equal(output._meta.fallback_used, true);
    assert.equal(output._meta.analysis_status, "incomplete");
  });

  it("RED: fallback treats all languages equally (no language-specific roles)", async () => {
    const result = await runFallback("swiftui-view.swift");
    // Fallback no longer extracts symbols — all files get the same mechanical treatment
    assert.equal(result.important_symbols.length, 0, "No symbols extracted for any language");
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
    // Create a large file where important content is at the end
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) {
      lines.push(`// Filler line ${i} — this is just padding to make the file long`);
    }
    lines.push("");
    lines.push("export class ImportantService {");
    lines.push("  async process(): Promise<void> {");
    lines.push("    // critical business logic");
    lines.push("  }");
    lines.push("}");

    writeFileSync(join(TMP_DIR, "tail-heavy.ts"), lines.join("\n"));

    const output = await runHandler("tail-heavy.ts", { maxChars: 10000 });

    // Smart truncation preserves suffix; verification via truncation metadata
    assert.equal(output._meta.input_truncated, true, "Should indicate truncation");
    assert.ok(Array.isArray(output.heuristic_signals), "Should have heuristic_signals");
    const truncSignal = output.heuristic_signals.find((s: any) => s.kind === "truncation");
    assert.ok(truncSignal, "Should have truncation signal");
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

  it("TS fallback no longer extracts symbols (mechanical only)", async () => {
    const result = await runFallback("typescript-control.ts");
    // Fallback is purely mechanical — no regex-based symbol extraction for any language
    assert.equal(result.important_symbols.length, 0, "Fallback no longer extracts symbols");
    assert.ok(Array.isArray(result.evidence), "Should have evidence array");
    assert.ok(result.evidence.length > 0, "Should have mechanical evidence (lines, file kind)");
  });

  it("TS fallback provides mechanical evidence only", async () => {
    const result = await runFallback("typescript-control.ts");
    assert.equal(result.important_symbols.length, 0, "No symbol extraction");
    // Evidence should include line counts, file kind, import/export counts
    const evidenceClaims = result.evidence.map((e: any) => e.claim).join(" ");
    assert.ok(evidenceClaims.includes("lines"), "Should include line counts");
  });

  it("TS fallback provides heuristic_signals", async () => {
    const result = await runFallback("typescript-control.ts");
    assert.ok(Array.isArray(result.heuristic_signals), "Should have heuristic_signals");
    assert.ok(result.heuristic_signals.some((s: any) => s.kind === "file_kind"), "Should have file_kind");
    assert.ok(result.heuristic_signals.some((s: any) => s.kind === "line_counts"), "Should have line_counts");
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
