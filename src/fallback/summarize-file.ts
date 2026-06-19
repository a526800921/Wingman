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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FallbackSummarizeResult {
  summary: string;
  important_symbols: Array<{
    name: string;
    kind:
      | "function"
      | "class"
      | "interface"
      | "type"
      | "const"
      | "enum"
      | "unknown";
    role: string;
    location?: string;
  }>;
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
  must_verify_in_source: boolean;
  is_authoritative: false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type SymbolKind = FallbackSummarizeResult["important_symbols"][number]["kind"];

interface RawSymbol {
  name: string;
  kind: SymbolKind;
  role: string;
  line: number;
}

/** Map file extension to a human-readable language name. */
function langFromExtension(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".py": "Python",
    ".pyi": "Python",
    ".rs": "Rust",
    ".go": "Go",
    ".java": "Java",
    ".md": "Markdown",
    ".mdx": "Markdown",
    ".json": "JSON",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".toml": "TOML",
    ".css": "CSS",
    ".scss": "SCSS",
    ".less": "LESS",
    ".html": "HTML",
    ".htm": "HTML",
    ".sql": "SQL",
    ".sh": "Shell",
    ".bash": "Shell",
    ".zsh": "Shell",
    ".c": "C",
    ".cpp": "C++",
    ".cc": "C++",
    ".cxx": "C++",
    ".h": "C/C++ Header",
    ".hpp": "C++ Header",
    ".rb": "Ruby",
    ".php": "PHP",
    ".swift": "Swift",
    ".kt": "Kotlin",
    ".kts": "Kotlin",
    ".xml": "XML",
    ".vue": "Vue",
    ".svelte": "Svelte",
  };
  return map[ext.toLowerCase()] ?? ext.slice(1).toUpperCase();
}

/** Compute 1-based line number from a match index in text. */
function lineNumberOf(text: string, pos: number): number {
  return text.slice(0, pos).split("\n").length;
}

/** Count parameters in a function parameter string (simple comma split). */
function countParams(paramStr: string): number {
  const trimmed = paramStr.trim();
  if (trimmed === "") return 0;
  return trimmed.split(",").length;
}

/**
 * Build a human-readable role string from the matched line context.
 */
function buildRole(
  line: string,
  kind: SymbolKind,
  name: string,
): string {
  const modifiers: string[] = [];

  if (/\bexport\b/.test(line)) modifiers.push("exported");
  if (/\bdefault\b/.test(line)) modifiers.push("default");
  if (/\basync\b/.test(line)) modifiers.push("async");
  if (/\babstract\b/.test(line)) modifiers.push("abstract");
  if (/\bpub\b/.test(line)) modifiers.push("public");

  switch (kind) {
    case "function": {
      // Try to extract parameter count from the matched line
      const paramMatch = line.match(
        new RegExp(
          `\\b${escapeRegex(name)}\\s*\\(([^)]*)\\)`,
        ),
      );
      const paramCount =
        paramMatch !== null ? countParams(paramMatch[1]) : 0;
      const paramLabel =
        paramCount === 1 ? "1 parameter" : `${paramCount} parameters`;
      modifiers.push(`function takes ${paramLabel}`);
      break;
    }
    case "class": {
      const extendsMatch = line.match(/\bextends\s+(\w+)/);
      if (extendsMatch !== null) {
        modifiers.push(`class extends ${extendsMatch[1]}`);
      } else {
        modifiers.push("class");
      }
      break;
    }
    case "interface": {
      const extendsMatch = line.match(/\bextends\s+/);
      modifiers.push(extendsMatch !== null ? "interface with extends" : "interface");
      break;
    }
    case "type":
      modifiers.push("type alias");
      break;
    case "const":
      modifiers.push("constant");
      break;
    case "enum":
      modifiers.push("enum");
      break;
    case "unknown":
      modifiers.push("symbol");
      break;
  }

  return modifiers.join(", ");
}

/** Escape special regex characters in a string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Symbol-extraction patterns
// ---------------------------------------------------------------------------

interface ExtractionPattern {
  regex: RegExp;
  kind: SymbolKind;
  /** Which capture group holds the symbol name. */
  nameGroup: number;
}

function buildPatterns(): ExtractionPattern[] {
  return [
    // ---------- functions ----------
    // TypeScript / JavaScript function declarations
    {
      regex: /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)/gm,
      kind: "function",
      nameGroup: 4,
    },
    // Rust: pub fn / fn
    {
      regex: /^\s*(pub(?:\s*\(\s*crate\s*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+(\w+)/gm,
      kind: "function",
      nameGroup: 4,
    },
    // Go: func
    {
      regex: /^\s*func\s+(\w+)/gm,
      kind: "function",
      nameGroup: 1,
    },
    // Python: def
    {
      regex: /^\s*def\s+(\w+)/gm,
      kind: "function",
      nameGroup: 1,
    },
    // Method / function shorthand: name(params) {  (after function/class already
    // captured, this catches plain method definitions in objects / classes)
    {
      regex: /^\s*(export\s+)?(async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm,
      kind: "function",
      nameGroup: 3,
    },

    // ---------- classes ----------
    // TypeScript / JavaScript / Java / Kotlin
    {
      regex: /^\s*(export\s+)?(abstract\s+)?class\s+(\w+)/gm,
      kind: "class",
      nameGroup: 3,
    },
    // Python
    {
      regex: /^\s*class\s+(\w+)/gm,
      kind: "class",
      nameGroup: 1,
    },

    // ---------- interfaces ----------
    {
      regex: /^\s*(export\s+)?interface\s+(\w+)/gm,
      kind: "interface",
      nameGroup: 2,
    },

    // ---------- type aliases ----------
    {
      regex: /^\s*(export\s+)?type\s+(\w+)\s*=/gm,
      kind: "type",
      nameGroup: 2,
    },

    // ---------- constants ----------
    {
      regex: /^\s*(export\s+)?const\s+(\w+)\s*=/gm,
      kind: "const",
      nameGroup: 2,
    },

    // ---------- enums ----------
    {
      regex: /^\s*(export\s+)?enum\s+(\w+)/gm,
      kind: "enum",
      nameGroup: 2,
    },
    // Rust enum
    {
      regex: /^\s*(pub\s+)?enum\s+(\w+)/gm,
      kind: "enum",
      nameGroup: 2,
    },
  ];
}

// ---------------------------------------------------------------------------
// Extraction logic
// ---------------------------------------------------------------------------

/**
 * Extract symbols from source text using the language-agnostic regex patterns.
 * Returns up to 15 most-significant symbols, de-duplicated by name (first
 * occurrence wins).
 */
function extractSymbols(text: string): RawSymbol[] {
  const patterns = buildPatterns();
  const seen = new Set<string>();
  const symbols: RawSymbol[] = [];

  for (const pat of patterns) {
    // Reset lastIndex for regexes with the global flag
    pat.regex.lastIndex = 0;
    for (const m of text.matchAll(pat.regex)) {
      const name = m[pat.nameGroup];
      if (name === undefined || name === "") continue;
      // Skip keywords that the regex may accidentally capture
      if (
        name === "if" ||
        name === "for" ||
        name === "while" ||
        name === "switch" ||
        name === "catch" ||
        name === "with" ||
        name === "try" ||
        name === "else" ||
        name === "return" ||
        name === "throw" ||
        name === "new" ||
        name === "typeof" ||
        name === "instanceof" ||
        name === "delete" ||
        name === "void"
      ) {
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);

      const line = lineNumberOf(text, m.index);
      const matchLine = text.split("\n")[line - 1] ?? m[0];

      symbols.push({
        name,
        kind: pat.kind,
        role: buildRole(matchLine, pat.kind, name),
        line,
      });
    }
  }

  // Sort: prioritise exported/public symbols, then by line number.
  symbols.sort((a, b) => {
    const aExp = a.role.startsWith("exported") || a.role.startsWith("public");
    const bExp = b.role.startsWith("exported") || b.role.startsWith("public");
    if (aExp !== bExp) return aExp ? -1 : 1;
    return a.line - b.line;
  });

  return symbols.slice(0, 15);
}

// ---------------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------------

interface ExtractedEvidence {
  claims: FallbackSummarizeResult["evidence"];
  /** Deduplicated module names from import statements. */
  importModules: string[];
  /** Counts of each symbol kind. */
  kindCounts: Record<string, number>;
}

function extractEvidence(
  text: string,
  symbols: RawSymbol[],
  ext: string,
): ExtractedEvidence {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const nonEmptyLines = lines.filter((l) => l.trim() !== "").length;

  // Comment-line detection (language-agnostic)
  let commentLines = 0;
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Multi-line block comment tracking (/* ... */)
    if (inBlockComment) {
      commentLines++;
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }

    if (trimmed.startsWith("/*")) {
      commentLines++;
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }

    // Single-line comments
    if (
      trimmed.startsWith("//") || // JS/TS/Go/Rust/Java/C/C++/Kotlin/Swift
      trimmed.startsWith("#") || // Python/Ruby/Shell/YAML/TOML
      trimmed.startsWith("--") || // SQL/Lua
      trimmed.startsWith("<!--") || // HTML/Markdown
      trimmed.startsWith("%") || // Erlang/Prolog
      trimmed.startsWith(";") // Lisp
    ) {
      commentLines++;
      continue;
    }

    // Empty line (already checked by startsWith for comment-like chars,
    // but an empty line could still be a line with only whitespace)
    if (trimmed === "") {
      // nonEmptyLines already filters these out — nothing extra to count
    }
  }

  const evidence: FallbackSummarizeResult["evidence"] = [];

  // Import modules extraction
  const importModules = extractImportModules(text, ext);
  if (importModules.length > 0) {
    evidence.push({
      claim: `Imports from ${importModules.length} module(s): ${importModules.slice(0, 10).join(", ")}${importModules.length > 10 ? ", ..." : ""}`,
      source: "import statement analysis",
      confidence: "high",
    });
  }

  // Import count
  const importMatches = text.match(/^\s*import\s+/gm);
  const importCount = importMatches !== null ? importMatches.length : 0;
  if (importCount > 0) {
    evidence.push({
      claim: `Found ${importCount} import statement(s)`,
      source: "regex: ^\\s*import\\s+",
      confidence: "high",
    });
  }

  // Export count
  const exportMatches = text.match(/^\s*export\s+/gm);
  const exportCount = exportMatches !== null ? exportMatches.length : 0;
  if (exportCount > 0) {
    evidence.push({
      claim: `Found ${exportCount} export statement(s)`,
      source: "regex: ^\\s*export\\s+",
      confidence: "high",
    });
  }

  // Symbol kind counts
  const kindCounts: Record<string, number> = {};
  for (const sym of symbols) {
    kindCounts[sym.kind] = (kindCounts[sym.kind] ?? 0) + 1;
  }
  for (const [kind, count] of Object.entries(kindCounts)) {
    evidence.push({
      claim: `Found ${count} ${kind} definition(s)`,
      source: "heuristic regex extraction",
      confidence: "medium",
    });
  }

  // Shebang
  if (text.startsWith("#!")) {
    const shebangLine = lines[0];
    evidence.push({
      claim: `File has shebang: ${shebangLine}`,
      source: "line 1 inspection",
      confidence: "high",
    });
  }

  // Strict mode (JS/TS)
  if (/^["']use strict["'];?$/m.test(text)) {
    evidence.push({
      claim: "File uses strict mode",
      source: "regex: use strict",
      confidence: "high",
    });
  }

  // Package declaration (Java / Kotlin / Go module)
  const pkgMatch = text.match(/^\s*package\s+(\S+)/m);
  if (pkgMatch !== null) {
    evidence.push({
      claim: `Package declaration: ${pkgMatch[1]}`,
      source: "regex: ^\\s*package\\s+",
      confidence: "high",
    });
  }

  // Line counts
  evidence.push({
    claim: `Total ${totalLines} lines (${nonEmptyLines} non-empty, ${commentLines} comment lines)`,
    source: "line counting",
    confidence: "high",
  });

  return { claims: evidence, importModules, kindCounts };
}

/**
 * Extract unique module names from import statements.
 * Handles JS/TS (import ... from 'module'), Python (from module import /
 * import module), and Go (import "module").
 */
function extractImportModules(text: string, ext: string): string[] {
  const modules = new Set<string>();

  // JS/TS style: import ... from 'module'  or  import 'module'
  const jsImportRe = /^\s*import\s+(?:.*?\bfrom\s+)?['"]([^'"]+)['"]/gm;
  for (const m of text.matchAll(jsImportRe)) {
    const mod = m[1];
    // Filter out relative imports (start with . or /)
    if (mod !== undefined && !mod.startsWith(".") && !mod.startsWith("/")) {
      modules.add(mod);
    }
  }

  // Dynamic import: import('module')
  const dynImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(dynImportRe)) {
    const mod = m[1];
    if (mod !== undefined && !mod.startsWith(".") && !mod.startsWith("/")) {
      modules.add(mod);
    }
  }

  // Python style: from module import ...  or  import module
  const pyFromRe = /^\s*from\s+(\S+)\s+import\s+/gm;
  for (const m of text.matchAll(pyFromRe)) {
    const mod = m[1];
    if (mod !== undefined && !mod.startsWith(".")) {
      modules.add(mod);
    }
  }
  const pyImportRe = /^\s*import\s+(\S+)/gm;
  for (const m of text.matchAll(pyImportRe)) {
    const mod = m[1];
    if (mod !== undefined && !mod.startsWith(".")) {
      modules.add(mod);
    }
  }

  // Go style: import "module"
  // Go single imports
  if ([".go"].includes(ext.toLowerCase())) {
    const goImportRe = /^\s*"[^"]+"/gm;
    for (const m of text.matchAll(goImportRe)) {
      const mod = m[0].replace(/^"|"$/g, "");
      if (mod !== "" && !mod.startsWith(".") && !mod.startsWith("/")) {
        modules.add(mod);
      }
    }
  }

  return [...modules].sort();
}

// ---------------------------------------------------------------------------
// Summary construction
// ---------------------------------------------------------------------------

function buildSummary(
  filename: string,
  totalLines: number,
  lang: string,
  symbolKindCounts: Record<string, number>,
  importModules: string[],
  topSymbols: RawSymbol[],
): string {
  const funcCount = symbolKindCounts["function"] ?? 0;
  const classCount = symbolKindCounts["class"] ?? 0;
  const moduleCount = importModules.length;

  const parts: string[] = [];
  parts.push(`${filename} (${totalLines} lines, ${lang}).`);

  const contentParts: string[] = [];
  if (funcCount > 0) contentParts.push(`${funcCount} functions`);
  if (classCount > 0) contentParts.push(`${classCount} classes`);
  if (contentParts.length > 0) {
    parts.push(`Contains ${contentParts.join(", ")}.`);
  }

  if (moduleCount > 0) {
    parts.push(
      `Imports from ${moduleCount} module(s): ${importModules.slice(0, 5).join(", ")}${moduleCount > 5 ? ", ..." : ""}.`,
    );
  }

  if (topSymbols.length > 0) {
    const names = topSymbols.slice(0, 5).map((s) => s.name);
    parts.push(`Top-level symbols: ${names.join(", ")}.`);
  }

  return parts.join(" ");
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
): FallbackSummarizeResult {
  const limitChars = maxChars ?? DEFAULT_MAX_READ_CHARS;

  // 1. Resolve the safe path
  let resolvedPath: string;
  try {
    resolvedPath = resolveSafePath(workspaceRoot, relativePath);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    throw new Error(
      `Path resolution failed for "${relativePath}": ${message}`,
    );
  }

  logger.debug("summarizeFileFallback: resolved path", {
    resolvedPath,
    limitChars,
  });

  // 2. Read the file
  let rawText: string;
  try {
    rawText = fs.readFileSync(resolvedPath, { encoding: "utf-8" });
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      throw new Error(
        `File not found: "${relativePath}" (resolved to "${resolvedPath}")`,
      );
    }
    if (nodeErr.code === "EACCES" || nodeErr.code === "EPERM") {
      throw new Error(
        `Permission denied reading file: "${relativePath}"`,
      );
    }
    if (nodeErr.code === "EISDIR") {
      throw new Error(
        `Path is a directory, not a file: "${relativePath}"`,
      );
    }
    throw new Error(
      `Failed to read file "${relativePath}": ${nodeErr.message}`,
    );
  }

  // Truncate to maxChars if needed
  const truncated = rawText.length > limitChars;
  const text = truncated ? rawText.slice(0, limitChars) : rawText;

  if (truncated) {
    logger.info(
      `summarizeFileFallback: truncating file from ${rawText.length} to ${limitChars} chars`,
    );
  }

  // 3. Determine file type from extension
  const ext = path.extname(relativePath).toLowerCase();
  const lang = langFromExtension(ext);

  // 4. Extract structured information
  const symbols = extractSymbols(text);
  const { claims: evidence, importModules, kindCounts } = extractEvidence(
    text,
    symbols,
    ext,
  );

  // 5. Build the summary string
  const filename = path.basename(relativePath);
  const totalLines = text.split("\n").length;
  const summary = buildSummary(
    filename,
    totalLines,
    lang,
    kindCounts,
    importModules,
    symbols,
  );

  // 6. Build important_symbols (already limited to 15 by extractSymbols)
  const important_symbols: FallbackSummarizeResult["important_symbols"] =
    symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      role: s.role,
      location: `line ${s.line}`,
    }));

  // 7. Build evidence array
  // Add the summary itself as evidence
  const allEvidence: FallbackSummarizeResult["evidence"] = [...evidence];
  if (truncated) {
    allEvidence.push({
      claim: `File was truncated from ${rawText.length} to ${limitChars} characters`,
      source: "read limit applied",
      confidence: "high",
    });
  }

  // 8. Build uncertainties
  const uncertainties: FallbackSummarizeResult["uncertainties"] = [
    {
      topic: "Summary accuracy",
      reason:
        "Heuristic-based summary — function bodies not analyzed. " +
        "The summary is based solely on structural patterns (declarations, " +
        "imports, exports) and does not reflect runtime behavior or logic.",
      suggested_verification:
        "Review the file manually or use the primary model-based summarizer " +
        "for a more accurate analysis.",
    },
    {
      topic: "Behavior and logic",
      reason:
        "Logic and behavior not evaluated. Control flow, error handling, " +
        "side effects, and algorithmic complexity are not assessed by the " +
        "fallback summarizer.",
      suggested_verification:
        "Run tests, review critical paths, or request a full model analysis.",
    },
    {
      topic: "Symbol visibility",
      reason:
        "Exported vs internal symbols may not be distinguished correctly. " +
        "The regex-based extraction does not fully resolve re-exports " +
        "(`export { X } from ...`), default exports, or namespace re-exports.",
      suggested_verification:
        "Check the module's public API surface manually or via the primary " +
        "summarizer.",
    },
    {
      topic: "Cross-language accuracy",
      reason:
        "Regex patterns are tuned primarily for TypeScript / JavaScript " +
        "and may miss or mis-classify symbols in other languages.",
      suggested_verification:
        "If the file is not TypeScript/JavaScript, manually review symbols.",
    },
  ];

  if (truncated) {
    uncertainties.push({
      topic: "Truncated content",
      reason: `File was truncated at ${limitChars} characters (original size: ${rawText.length}). Symbols and evidence beyond this limit were not extracted.`,
      suggested_verification:
        "Increase maxChars or use the model-based summarizer for complete analysis.",
    });
  }

  logger.debug("summarizeFileFallback: result", {
    filename,
    symbolCount: important_symbols.length,
    evidenceCount: allEvidence.length,
    uncertaintyCount: uncertainties.length,
  });

  return {
    summary,
    important_symbols,
    evidence: allEvidence,
    uncertainties,
    must_verify_in_source: true,
    is_authoritative: false,
  };
}
