/**
 * TypeScript compiler output diagnostic parser.
 *
 * Parses `tsc --noEmit` and `tsc --noEmit --pretty` output into complete
 * CommandDiagnostic blocks using a line-by-line state machine.
 *
 * Design:
 *   1. Strip ANSI control codes
 *   2. Detect diagnostic header lines (3 formats supported)
 *   3. Collect subsequent detail lines (indented text, code frames, type expansions)
 *   4. Terminate on next header, tsc summary, or build-tool boundary
 *   5. Classify each diagnostic's source_kind (project/test/generated/dependency)
 */

import type { CommandDiagnostic, DiagnosticKind } from "./types.js";
import type { SourceKind } from "./types.js";

// ── ANSI stripping ────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// ── Source classification ─────────────────────────────────

/** Patterns that indicate generated/build output files. */
const GENERATED_DIRS = [
  ".next/", "dist/", "build/", "out/",
  "__generated__/", ".gen/",
];

/** Configurable list — callers can extend via this export. */
export const EXTRA_GENERATED_PATTERNS: string[] = [];

function isGeneratedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  for (const dir of GENERATED_DIRS) {
    // Match dir at start of path or after /
    const re = new RegExp(`(?:^|/)${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    if (re.test(normalized)) return true;
  }
  for (const pat of EXTRA_GENERATED_PATTERNS) {
    if (normalized.includes(pat)) return true;
  }
  if (/\.generated\.\w+$/i.test(normalized)) return true;
  // .d.ts files in cache dirs
  if (/(?:^|\/)\.cache\//.test(normalized) && /\.d\.\w+$/.test(normalized)) return true;
  return false;
}

export function classifySourceKind(filePath: string | undefined): SourceKind {
  if (!filePath) return "unknown";
  const normalized = filePath.replace(/\\/g, "/");

  // node_modules at any position
  if (/(?:^|\/)node_modules\//.test(normalized)) return "dependency";
  // generated/build dirs
  if (isGeneratedPath(normalized)) return "generated";
  // test/spec files
  if (/\.(test|spec)\.\w+$/i.test(normalized) || /\/__tests__\//.test(normalized)
      || /^__tests__\//.test(normalized)) return "test";
  // project source: dirs at start or after /
  if (/(?:^|\/)(src|lib|app|pages|components|utils|hooks|services)\//.test(normalized)
      || /^\.\.?[/\\]/.test(filePath)) return "project";

  return "unknown";
}

// ── Diagnostic ID generation ──────────────────────────────

let diagnosticSeq = 0;

function buildDiagnosticId(
  kind: DiagnosticKind,
  file: string | undefined,
  line: number | undefined,
  errorCode: string | undefined,
): string {
  const parts: string[] = [kind];
  if (file) parts.push(file.replace(/\\/g, "/"));
  if (line !== undefined) parts.push(`L${line}`);
  if (errorCode) parts.push(errorCode);
  parts.push(String(++diagnosticSeq));
  return parts.join(":");
}

// ── State machine ──────────────────────────────────────────

enum ParseState {
  IDLE,
  IN_DIAGNOSTIC,
}

/** Maximum chars in a single diagnostic block before forced truncation. */
const MAX_DIAGNOSTIC_CHARS = 8000;
/** Maximum lines in a single diagnostic block before forced truncation. */
const MAX_DIAGNOSTIC_LINES = 80;
/** Max consecutive empty lines within a diagnostic before treating as boundary. */
const MAX_CONSECUTIVE_EMPTY_LINES = 2;

/**
 * TSC error header pattern — classic format:
 *   src/app.ts(10,5): error TS2322: Type 'string' is not assignable...
 */
const TSC_HEADER_CLASSIC_RE = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;

/**
 * TSC error header — pretty format (after ANSI strip):
 *   src/app.ts:10:5: error TS2322: Type 'string' is not assignable...
 * The pretty format uses cyan/red coloring; after stripAnsi it becomes plain.
 */
const TSC_HEADER_PRETTY_RE = /^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s*(.+)$/;

/**
 * TSC error without file position (global config error):
 *   error TS5058: Directory does not exist...
 */
const TSC_HEADER_GLOBAL_RE = /^(error|warning)\s+(TS\d+):\s*(.+)$/;

/** Lines that terminate the current diagnostic block. */
const TERMINATOR_RES: RegExp[] = [
  /^Found\s+\d+\s+error/i,         // "Found 14 errors in 5 files"
  /^Watching for file changes/i,   // --watch mode restart
  /^npm\s+ERR!/i,                  // npm error boundary
  /^pnpm\s+ERR!/i,                 // pnpm error boundary
  /^yarn\s+error/i,                // yarn error boundary
  /^error Command failed/i,        // yarn/npm failure
  /^ELIFECYCLE/i,                  // npm lifecycle error
  /^\s*Tests?:/m,                  // test summary boundary
];

function isTerminatorLine(line: string): boolean {
  for (const re of TERMINATOR_RES) {
    if (re.test(line)) return true;
  }
  return false;
}

function isDiagnosticHeader(line: string): boolean {
  return TSC_HEADER_CLASSIC_RE.test(line)
    || TSC_HEADER_PRETTY_RE.test(line)
    || TSC_HEADER_GLOBAL_RE.test(line);
}

/**
 * Returns true if `line` looks like it continues the previous diagnostic.
 * Detects: indented text, type expansions, code frames, related info.
 */
function isDetailLine(line: string, prevLine: string): boolean {
  // Indented whitespace (relative to diagnostic header margin)
  if (/^\s{2,}/.test(line) && line.trim().length > 0) return true;

  // Code frame: starts with spaces + ~ (underline markers in pretty mode)
  if (/^\s+~/.test(line)) return true;

  // Code frame: starts with a line number + code content (pretty mode)
  // e.g. "10     foo("hello");"
  if (/^\s*\d+\s{2,}\S/.test(line)) return true;

  // Code frame: whitespace + pipe or caret
  if (/^\s+[|^]/.test(line)) return true;

  // Related information line (pretty mode)
  if (/^\s{2,}(The|Did you|Try|See|Consider|Check|Property|Type|Index signature|Overload)/i.test(line)) return true;

  // Empty line between detail lines (but not too many consecutive)
  if (line.trim().length === 0 && prevLine.trim().length > 0) return true;

  return false;
}

function parseClassicHeader(match: RegExpExecArray, index: number): Partial<CommandDiagnostic> {
  return {
    kind: "type_error" as DiagnosticKind,
    file: match[1],
    line: Number(match[2]),
    column: Number(match[3]),
    error_code: match[4],
    headline: match[5].trim(),
    first_seen_index: index,
    parser_confidence: "high",
  };
}

function parsePrettyHeader(match: RegExpExecArray, index: number): Partial<CommandDiagnostic> {
  return {
    kind: "type_error" as DiagnosticKind,
    file: match[1],
    line: Number(match[2]),
    column: Number(match[3]),
    error_code: match[4],
    headline: match[5].trim(),
    first_seen_index: index,
    parser_confidence: "high",
  };
}

function parseGlobalHeader(match: RegExpExecArray, index: number): Partial<CommandDiagnostic> {
  const isWarning = match[1].toLowerCase() === "warning";
  return {
    kind: (isWarning ? "warning" : "type_error") as DiagnosticKind,
    error_code: match[2],
    headline: match[3].trim(),
    first_seen_index: index,
    parser_confidence: "high",
  };
}

function buildDiagnostic(partial: Partial<CommandDiagnostic>): CommandDiagnostic {
  const kind = partial.kind ?? "unknown";
  const sourceKind = classifySourceKind(partial.file);
  return {
    id: buildDiagnosticId(kind, partial.file, partial.line, partial.error_code),
    kind,
    source_kind: sourceKind,
    actionability: sourceKind === "project" || sourceKind === "test" ? "high" : sourceKind === "generated" ? "low" : "medium",
    file: partial.file,
    line: partial.line,
    column: partial.column,
    error_code: partial.error_code,
    rule_id: partial.rule_id,
    headline: partial.headline ?? "",
    details: partial.details ?? [],
    evidence: partial.evidence ?? "",
    first_seen_index: partial.first_seen_index ?? 0,
    parser_confidence: partial.parser_confidence ?? "medium",
    truncated: partial.truncated ?? false,
  };
}

// ── Public API ─────────────────────────────────────────────

export interface ParseTscResult {
  diagnostics: CommandDiagnostic[];
  /** Segments of the output that could not be parsed into diagnostics. */
  unrecognized_segments: string[];
}

/**
 * Parse tsc output into structured CommandDiagnostic blocks.
 *
 * Uses a line-by-line state machine:
 *   IDLE → detect header → IN_DIAGNOSTIC → collect detail lines → terminate → IDLE
 *
 * @param output Raw tsc stdout/stderr (may contain ANSI codes)
 * @param maxDiagnosticChars Max chars per diagnostic block (default 8000)
 * @param maxDiagnosticLines Max lines per diagnostic block (default 80)
 */
export function parseTscDiagnostics(
  output: string,
  maxDiagnosticChars: number = MAX_DIAGNOSTIC_CHARS,
  maxDiagnosticLines: number = MAX_DIAGNOSTIC_LINES,
): ParseTscResult {
  // Reset sequence counter for deterministic id generation
  diagnosticSeq = 0;

  const clean = stripAnsi(output);
  const lines = clean.split(/\r?\n/);
  const diagnostics: CommandDiagnostic[] = [];
  const unrecognized: string[] = [];

  let state: ParseState = ParseState.IDLE;
  let currentHeader: string | null = null;
  let currentDetailLines: string[] = [];
  let currentStartIndex = 0;
  let currentLineCount = 0;
  let currentCharCount = 0;
  let currentPartial: Partial<CommandDiagnostic> | null = null;
  let consecutiveEmptyLines = 0;

  // Lines that were not part of any diagnostic
  let unrecognizedLines: string[] = [];
  let unrecognizedStartIdx = 0;

  function commitDiagnostic(): void {
    if (!currentPartial) return;

    const headerLine = currentHeader ?? "";
    const evidenceLines = [headerLine, ...currentDetailLines];
    const evidence = evidenceLines.join("\n");

    const diagnostic = buildDiagnostic({
      ...currentPartial,
      details: currentDetailLines,
      evidence,
      first_seen_index: currentStartIndex,
    });

    diagnostics.push(diagnostic);

    currentHeader = null;
    currentDetailLines = [];
    currentPartial = null;
    currentLineCount = 0;
    currentCharCount = 0;
    consecutiveEmptyLines = 0;
  }

  function flushUnrecognized(): void {
    if (unrecognizedLines.length === 0) return;
    const text = unrecognizedLines.join("\n");
    if (text.trim().length > 0) {
      unrecognized.push(text);
    }
    unrecognizedLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStartIdx = clean.indexOf(line, i > 0 ? clean.indexOf(lines[i - 1]) + lines[i - 1].length + 1 : 0);

    // ── Check for terminators (applies in any state except IDLE before first header) ──
    if (state === ParseState.IN_DIAGNOSTIC && isTerminatorLine(line)) {
      commitDiagnostic();
      state = ParseState.IDLE;
      // The terminator line itself goes to unrecognized
      if (unrecognizedLines.length === 0) unrecognizedStartIdx = lineStartIdx;
      unrecognizedLines.push(line);
      flushUnrecognized();
      continue;
    }

    // ── Check for diagnostic header ──
    let headerMatch: RegExpExecArray | null;

    // Classic: file(line,col): error TS####: message
    TSC_HEADER_CLASSIC_RE.lastIndex = 0;
    headerMatch = TSC_HEADER_CLASSIC_RE.exec(line);
    if (headerMatch) {
      // Commit previous diagnostic if in one
      if (state === ParseState.IN_DIAGNOSTIC) {
        commitDiagnostic();
        flushUnrecognized();
      } else {
        flushUnrecognized();
      }

      currentHeader = line;
      currentDetailLines = [];
      currentStartIndex = lineStartIdx >= 0 ? lineStartIdx : i;
      currentLineCount = 1;
      currentCharCount = line.length;
      currentPartial = parseClassicHeader(headerMatch, currentStartIndex);
      state = ParseState.IN_DIAGNOSTIC;
      unrecognizedLines = [];
      continue;
    }

    // Pretty: file:line:col - error TS####: message
    TSC_HEADER_PRETTY_RE.lastIndex = 0;
    headerMatch = TSC_HEADER_PRETTY_RE.exec(line);
    if (headerMatch) {
      if (state === ParseState.IN_DIAGNOSTIC) {
        commitDiagnostic();
        flushUnrecognized();
      } else {
        flushUnrecognized();
      }

      currentHeader = line;
      currentDetailLines = [];
      currentStartIndex = lineStartIdx >= 0 ? lineStartIdx : i;
      currentLineCount = 1;
      currentCharCount = line.length;
      currentPartial = parsePrettyHeader(headerMatch, currentStartIndex);
      state = ParseState.IN_DIAGNOSTIC;
      unrecognizedLines = [];
      continue;
    }

    // Global: error TS####: message (no file position)
    TSC_HEADER_GLOBAL_RE.lastIndex = 0;
    headerMatch = TSC_HEADER_GLOBAL_RE.exec(line);
    if (headerMatch && !/^\s+/.test(line)) {  // avoid matching indented "error" mentions
      if (state === ParseState.IN_DIAGNOSTIC) {
        commitDiagnostic();
        flushUnrecognized();
      } else {
        flushUnrecognized();
      }

      currentHeader = line;
      currentDetailLines = [];
      currentStartIndex = lineStartIdx >= 0 ? lineStartIdx : i;
      currentLineCount = 1;
      currentCharCount = line.length;
      currentPartial = parseGlobalHeader(headerMatch, currentStartIndex);
      state = ParseState.IN_DIAGNOSTIC;
      unrecognizedLines = [];
      continue;
    }

    // ── In diagnostic: check for detail lines ──
    if (state === ParseState.IN_DIAGNOSTIC) {
      const prevLine = currentDetailLines.length > 0
        ? currentDetailLines[currentDetailLines.length - 1]
        : (currentHeader ?? "");

      // Empty line — track consecutive count
      if (line.trim().length === 0) {
        consecutiveEmptyLines++;
        if (consecutiveEmptyLines > MAX_CONSECUTIVE_EMPTY_LINES) {
          // Too many empty lines → terminate diagnostic
          commitDiagnostic();
          state = ParseState.IDLE;
          if (unrecognizedLines.length === 0) unrecognizedStartIdx = lineStartIdx;
          unrecognizedLines.push(line);
          continue;
        }
        currentDetailLines.push(line);
        currentLineCount++;
        currentCharCount += line.length;
        continue;
      }

      consecutiveEmptyLines = 0;

      // Truncation check
      if (currentCharCount + line.length > maxDiagnosticChars || currentLineCount >= maxDiagnosticLines) {
        if (currentPartial) currentPartial.truncated = true;
        commitDiagnostic();
        state = ParseState.IDLE;
        // Fall through to process this line normally
        if (unrecognizedLines.length === 0) unrecognizedStartIdx = lineStartIdx;
        unrecognizedLines.push(line);
        continue;
      }

      if (isDetailLine(line, prevLine)) {
        currentDetailLines.push(line);
        currentLineCount++;
        currentCharCount += line.length;
        continue;
      }

      // Not a detail line and not a header — terminate diagnostic
      commitDiagnostic();
      state = ParseState.IDLE;
      // Process this line as unrecognized
      if (unrecognizedLines.length === 0) unrecognizedStartIdx = lineStartIdx;
      unrecognizedLines.push(line);
      continue;
    }

    // ── In IDLE: accumulate unrecognized lines ──
    if (unrecognizedLines.length === 0) unrecognizedStartIdx = lineStartIdx >= 0 ? lineStartIdx : i;
    unrecognizedLines.push(line);
  }

  // ── End of input — commit any open diagnostic ──
  if (state === ParseState.IN_DIAGNOSTIC) {
    commitDiagnostic();
  }
  flushUnrecognized();

  return { diagnostics, unrecognized_segments: unrecognized };
}
