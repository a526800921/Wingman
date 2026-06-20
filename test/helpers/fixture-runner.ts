/**
 * Minimal fixture replay runner.
 *
 * Reads UTF-8 fixture files and their JSON expectations, runs the
 * deterministic parser/fallback, and provides small assertion helpers.
 *
 * IMPORTANT: This runner must NOT duplicate production parsing logic.
 * It only calls the public API of the production modules.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { strict as assert } from "node:assert";
import { parseTscDiagnostics } from "../../src/diagnostics/tsc-parser.js";
import { compressCommandOutputFallback } from "../../src/fallback/compress-command-output.js";
import { reviewDiffByFileFallback } from "../../src/fallback/review-diff-by-file.js";

// ── Types ─────────────────────────────────────────────────

export interface CommandOutputExpectation {
  fixture: string;
  command?: string;
  exit_code?: number;
  expected: {
    diagnostics?: number;
    findings?: number;
    must_include_codes?: string[];
    must_include_files?: string[];
    must_not_include_evidence?: string[];
    generated_findings?: number;
    max_structure_only_model_calls?: number;
    max_enrichment_model_calls?: number;
  };
}

export interface DiffExpectation {
  fixture: string;
  expected: {
    min_findings?: number;
    must_include_risks?: string[];
    files_count?: number;
  };
}

// ── Helpers ───────────────────────────────────────────────

const FIXTURES_DIR = path.join(import.meta.dirname, "..", "fixtures");

function resolvePath(relative: string): string {
  const resolved = path.resolve(FIXTURES_DIR, relative);
  if (!resolved.startsWith(FIXTURES_DIR)) {
    throw new Error(`Path traversal detected: ${relative}`);
  }
  return resolved;
}

export function readFixture(relativePath: string): string {
  return fs.readFileSync(resolvePath(relativePath), "utf-8");
}

export function readExpectation<T>(relativePath: string): T {
  const raw = fs.readFileSync(resolvePath(relativePath), "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * Run the TSC parser on a fixture and return structured results.
 * Does NOT duplicate parsing logic — calls parseTscDiagnostics directly.
 */
export function replayCommandOutput(fixturePath: string): {
  diagnostics: ReturnType<typeof parseTscDiagnostics>["diagnostics"];
  fallback: ReturnType<typeof compressCommandOutputFallback>;
} {
  const content = readFixture(fixturePath);
  const parsed = parseTscDiagnostics(content);
  const fb = compressCommandOutputFallback(undefined, content, undefined);
  return { diagnostics: parsed.diagnostics, fallback: fb };
}

/**
 * Run the diff fallback on a fixture.
 */
export function replayDiff(fixturePath: string): ReturnType<typeof reviewDiffByFileFallback> {
  const content = readFixture(fixturePath);
  return reviewDiffByFileFallback(content);
}

// ── Shared assertion helpers ──────────────────────────────

/** Assert that all expected codes appear in the findings' error_code fields. */
export function assertIncludesCodes(
  findings: Array<{ error_code?: string }>,
  codes: string[],
  fixtureName: string,
): void {
  const foundCodes = new Set(findings.map(f => f.error_code).filter(Boolean) as string[]);
  for (const code of codes) {
    assert.ok(
      foundCodes.has(code),
      `[${fixtureName}] Expected error code "${code}" but not found. Found: ${[...foundCodes].join(", ")}`,
    );
  }
}

/** Assert that all expected files appear in the findings' file fields. */
export function assertIncludesFiles(
  findings: Array<{ file?: string }>,
  files: string[],
  fixtureName: string,
): void {
  const foundFiles = new Set(findings.map(f => f.file).filter(Boolean) as string[]);
  for (const file of files) {
    assert.ok(
      foundFiles.has(file),
      `[${fixtureName}] Expected file "${file}" but not found. Found: ${[...foundFiles].join(", ")}`,
    );
  }
}

/** Assert that no finding evidence contains any of the forbidden strings. */
export function assertNotIncludesEvidence(
  findings: Array<{ evidence?: string }>,
  forbidden: string[],
  fixtureName: string,
): void {
  for (const f of findings) {
    for (const s of forbidden) {
      assert.ok(
        !(f.evidence ?? "").includes(s),
        `[${fixtureName}] Finding evidence should not contain "${s}". Evidence: ${f.evidence?.slice(0, 200)}`,
      );
    }
  }
}

/** Assert that risk keywords appear in findings (case-insensitive). */
export function assertIncludesRisks(
  findings: Array<{ risk?: string; evidence?: string }>,
  riskTerms: string[],
  fixtureName: string,
): void {
  const allText = findings
    .map(f => `${f.risk ?? ""} ${f.evidence ?? ""}`)
    .join(" ")
    .toLowerCase();
  for (const term of riskTerms) {
    assert.ok(
      allText.includes(term.toLowerCase()),
      `[${fixtureName}] Expected risk term "${term}" not found in any finding.`,
    );
  }
}
