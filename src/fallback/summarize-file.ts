/**
 * Heuristic-based file summarizer — works without a model API call.
 *
 * Extracts structured information (symbols, evidence, uncertainties) from
 * source files using language-agnostic regex patterns. Designed as a
 * fallback when the primary model-based summarization is unavailable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSafePath, DEFAULT_MAX_READ_CHARS } from "../workspace.js";
import { logger } from "../logger.js";
import { splitPrefixSuffix, joinPrefixSuffix } from "../model-runtime/truncation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeuristicSignal {
  kind: string;
  location?: string;
  evidence: string;
  confidence: "low" | "medium";
}

export interface FallbackSummarizeResult {
  summary: string;
  file_kind?: "code" | "markdown" | "text" | "test" | "unknown";
  important_symbols: Array<{
    name: string;
    kind:
      | "function"
      | "class"
      | "interface"
      | "type"
      | "const"
      | "enum"
      | "struct"
      | "unknown";
    role: string;
    location?: string;
  }>;
  important_sections?: Array<{ heading: string; role: string; location?: string }>;
  test_cases?: Array<{ name: string; behavior: string; location?: string }>;
  covered_behaviors?: string[];
  evidence: Array<{
    claim: string;
    source: string;
    confidence?: "high" | "medium" | "low";
  }>;
  uncertainties: Array<{
    topic: string;
    reason: string;
    suggested_verification?: string;
  }>;
  heuristic_signals?: HeuristicSignal[];
  must_verify_in_source: boolean;
  is_authoritative: false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Map file extension to a human-readable language name. */
function langFromExtension(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript",
    ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".py": "Python", ".pyi": "Python", ".rs": "Rust", ".go": "Go",
    ".java": "Java", ".md": "Markdown", ".mdx": "Markdown",
    ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
    ".css": "CSS", ".scss": "SCSS", ".less": "LESS",
    ".html": "HTML", ".htm": "HTML", ".sql": "SQL",
    ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
    ".c": "C", ".cpp": "C++", ".cc": "C++", ".cxx": "C++",
    ".h": "C/C++ Header", ".hpp": "C++ Header",
    ".rb": "Ruby", ".php": "PHP", ".swift": "Swift",
    ".kt": "Kotlin", ".kts": "Kotlin", ".xml": "XML",
    ".vue": "Vue", ".svelte": "Svelte",
  };
  return map[ext.toLowerCase()] ?? ext.slice(1).toUpperCase();
}

/** Compute 1-based line number from a match index in text. */
function lineNumberOf(text: string, pos: number): number {
  const line = text.slice(0, pos).split("\n").length;
  if (pos < text.length && text[pos] === "\n") return line + 1;
  return line;
}

// ---------------------------------------------------------------------------
// File-kind detection
// ---------------------------------------------------------------------------

/**
 * Detect the kind of file based on its name and extension.
 * Returns "test", "markdown", "text", "code", or "unknown".
 */
function detectFileKind(filePath: string): FallbackSummarizeResult["file_kind"] {
  const basename = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();

  // Test files
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(basename)) return "test";
  if (filePath.replace(/\\/g, "/").includes("__tests__/")) return "test";

  // Markdown / text
  if (ext === ".md" || ext === ".mdx") return "markdown";
  if (ext === ".txt") return "text";

  // Code files (common extensions)
  const codeExts = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".pyi", ".rs", ".go", ".java", ".kt", ".kts",
    ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp",
    ".rb", ".php", ".swift", ".vue", ".svelte",
    ".css", ".scss", ".less", ".html", ".htm",
    ".sql", ".sh", ".bash", ".zsh", ".json", ".yaml", ".yml", ".toml",
    ".xml", ".graphql", ".gql", ".proto",
  ]);
  if (codeExts.has(ext)) return "code";

  return "unknown";
}

// ---------------------------------------------------------------------------
// Markdown / text section extraction
// ---------------------------------------------------------------------------

/**
 * Extract headings from markdown/text content as important_sections.
 */
function extractSections(
  text: string,
): Array<{ heading: string; role: string; location?: string }> {
  const sections: Array<{ heading: string; role: string; location?: string }> = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  for (const m of text.matchAll(headingRegex)) {
    const level = m[1].length;
    const heading = m[2].trim();
    if (heading.length === 0) continue;
    const line = lineNumberOf(text, m.index);
    sections.push({
      heading,
      role: `h${level} heading`,
      location: `line ${line}`,
    });
  }
  return sections.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Test file extraction
// ---------------------------------------------------------------------------

/** Framework symbols to exclude from important_symbols in test files. */
const TEST_FRAMEWORK_SYMBOLS = new Set([
  "describe", "it", "test", "expect",
  "beforeEach", "afterEach", "beforeAll", "afterAll",
  "vi", "jest",
]);

/**
 * Extract test case names and behaviors from it() / test() calls.
 */
function extractTestCases(
  text: string,
): Array<{ name: string; behavior: string; location?: string }> {
  const testCases: Array<{ name: string; behavior: string; location?: string }> = [];
  const testRegex = /(?:it|test)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (const m of text.matchAll(testRegex)) {
    const name = m[1];
    if (name.length === 0) continue;
    const line = lineNumberOf(text, m.index);
    testCases.push({
      name,
      behavior: `Test: ${name}`,
      location: `line ${line}`,
    });
  }
  return testCases;
}

/**
 * Extract describe() block names as covered_behaviors.
 */
function extractCoveredBehaviors(text: string): string[] {
  const behaviors: string[] = [];
  const describeRegex = /describe\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (const m of text.matchAll(describeRegex)) {
    const name = m[1];
    if (name.length === 0) continue;
    behaviors.push(name);
  }
  return behaviors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a heuristic-based summary of a file without calling any model API.
 *
 * Reads the file at `workspaceRoot/relativePath`, extracts symbols, evidence,
 * and uncertainties using regex patterns, and returns a structured result
 * suitable for the fallback path of `aux_summarize_file`.
 *
 * @param workspaceRoot  Trusted workspace root directory.
 * @param relativePath   File path relative to the workspace root.
 * @param maxChars       Maximum characters to read from the file (defaults to
 *                       `DEFAULT_MAX_READ_CHARS` from workspace config).
 * @returns              Structured fallback summary result.
 * @throws               Error if the path is unsafe or the file cannot be read.
 */
export function summarizeFileFallback(
  workspaceRoot: string,
  relativePath: string,
  maxChars?: number,
  fileContent?: string,
): FallbackSummarizeResult {
  const limitChars = maxChars ?? DEFAULT_MAX_READ_CHARS;

  // 1. Read file content (use provided content if available, otherwise read from disk)
  let rawText: string;
  if (fileContent !== undefined) {
    rawText = fileContent;
  } else {
    let resolvedPath: string;
    try {
      resolvedPath = resolveSafePath(workspaceRoot, relativePath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Path resolution failed for "${relativePath}": ${message}`);
    }

    logger.debug("summarizeFileFallback: resolved path", { resolvedPath, limitChars });

    try {
      rawText = fs.readFileSync(resolvedPath, { encoding: "utf-8" });
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") throw new Error(`File not found: "${relativePath}"`);
      if (nodeErr.code === "EACCES" || nodeErr.code === "EPERM") throw new Error(`Permission denied reading file: "${relativePath}"`);
      if (nodeErr.code === "EISDIR") throw new Error(`Path is a directory, not a file: "${relativePath}"`);
      throw new Error(`Failed to read file "${relativePath}": ${nodeErr.message}`);
    }
  }

  // 2. Smart truncation (preserve prefix + suffix)
  const truncated = rawText.length > limitChars;
  let text: string;
  let omittedChars = 0;

  if (truncated) {
    const split = splitPrefixSuffix(rawText, limitChars);
    text = joinPrefixSuffix(split.prefix, split.suffix, split.omittedChars);
    omittedChars = split.omittedChars;
  } else {
    text = rawText;
  }

  // 3. Determine file type from extension
  const ext = path.extname(relativePath).toLowerCase();
  const lang = langFromExtension(ext);
  const fileKind = detectFileKind(relativePath);
  const filename = path.basename(relativePath);

  // 4. Mechanical counts (no semantic analysis)
  const lines = text.split("\n");
  const totalLines = lines.length;
  const nonEmptyLines = lines.filter(l => l.trim() !== "").length;

  // Comment line count
  let commentLines = 0;
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlockComment) { commentLines++; if (trimmed.includes("*/")) inBlockComment = false; continue; }
    if (trimmed.startsWith("/*")) { commentLines++; if (!trimmed.includes("*/")) inBlockComment = true; continue; }
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("--") ||
        trimmed.startsWith("<!--") || trimmed.startsWith("%") || trimmed.startsWith(";")) {
      commentLines++; continue;
    }
  }

  // Import/export counts (numbers only, no module names)
  const importCount = (text.match(/^\s*import\s+/gm) || []).length;
  const exportCount = (text.match(/^\s*export\s+/gm) || []).length;

  // 5. File-kind-specific extraction (headings for markdown, test names for tests)
  let importantSections: FallbackSummarizeResult["important_sections"];
  let testCases: FallbackSummarizeResult["test_cases"];
  let coveredBehaviors: FallbackSummarizeResult["covered_behaviors"];

  if (fileKind === "markdown" || fileKind === "text") {
    importantSections = extractSections(text);
  }
  if (fileKind === "test") {
    testCases = extractTestCases(text);
    coveredBehaviors = extractCoveredBehaviors(text);
  }

  // 6. Build summary (mechanical facts only)
  const summaryParts = [`${filename} (${totalLines} lines, ${lang}). File kind: ${fileKind}.`];
  if (importCount > 0) summaryParts.push(`${importCount} import statement(s).`);
  if (exportCount > 0) summaryParts.push(`${exportCount} export statement(s).`);
  const summary = summaryParts.join(" ");

  // 7. important_symbols: always empty (no regex-based symbol extraction)
  const important_symbols: FallbackSummarizeResult["important_symbols"] = [];

  // 8. Evidence — deterministic mechanical signals only
  const evidence: FallbackSummarizeResult["evidence"] = [
    { claim: `Total ${totalLines} lines (${nonEmptyLines} non-empty, ${commentLines} comment lines)`, source: "line counting", confidence: "high" },
    { claim: `File kind detected: ${fileKind}`, source: "extension and path-based detection", confidence: fileKind === "unknown" ? "low" : "high" },
  ];
  if (importCount > 0) evidence.push({ claim: `Found ${importCount} import statement(s)`, source: "regex: ^\\s*import\\s+", confidence: "high" });
  if (exportCount > 0) evidence.push({ claim: `Found ${exportCount} export statement(s)`, source: "regex: ^\\s*export\\s+", confidence: "high" });
  if (text.startsWith("#!")) evidence.push({ claim: `File has shebang: ${lines[0]}`, source: "line 1 inspection", confidence: "high" });
  if (/^["']use strict["'];?$/m.test(text)) evidence.push({ claim: "File uses strict mode", source: "regex: use strict", confidence: "high" });
  if (truncated) evidence.push({ claim: `File truncated — ${omittedChars} chars omitted, ${text.length} chars analyzed`, source: "smart truncation (prefix + suffix)", confidence: "high" });

  // 9. heuristic_signals — mechanical only, no semantic deduction
  const heuristicSignals: HeuristicSignal[] = [
    { kind: "line_counts", evidence: `${totalLines} total, ${nonEmptyLines} non-empty`, confidence: "medium" },
    { kind: "file_kind", evidence: `Detected as ${fileKind} (language: ${lang})`, confidence: fileKind === "unknown" ? "low" : "medium" },
  ];
  if (truncated) heuristicSignals.push({ kind: "truncation", evidence: `${omittedChars} chars omitted beyond budget`, confidence: "medium" });

  // 10. Uncertainties — explicit: no semantic analysis performed
  const uncertainties: FallbackSummarizeResult["uncertainties"] = [
    {
      topic: "No semantic analysis performed",
      reason: "The heuristic fallback performs ONLY mechanical counting (lines, file type, import/export counts). Functions, classes, interfaces, control flow, error handling, side effects, and algorithmic complexity are NOT analyzed. The calling model should READ the file directly for semantic understanding.",
      suggested_verification: "Use the model-based summarizer, or read the file directly with your Read tool.",
    },
  ];
  if (truncated) {
    uncertainties.push({
      topic: "Truncated content",
      reason: `File truncated: ${omittedChars} characters omitted. Smart truncation preserves both prefix and suffix, but the middle section was not scanned.`,
      suggested_verification: "Increase maxChars or use the model-based summarizer for complete analysis.",
    });
  }

  logger.debug("summarizeFileFallback: result", { filename, fileKind, totalLines });

  return {
    summary,
    file_kind: fileKind,
    important_symbols,
    ...(importantSections ? { important_sections: importantSections } : {}),
    ...(testCases ? { test_cases: testCases } : {}),
    ...(coveredBehaviors ? { covered_behaviors: coveredBehaviors } : {}),
    evidence,
    uncertainties,
    heuristic_signals: heuristicSignals,
    must_verify_in_source: true,
    is_authoritative: false,
  };
}
