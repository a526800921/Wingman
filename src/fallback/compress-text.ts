/**
 * Heuristic text compressor — pattern-based, no model API calls.
 *
 * Used as a fallback when the primary model-based compression is unavailable
 * or when the input is too large for the model context window.
 */

import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface FallbackCompressResult {
  summary: string;
  key_facts: string[];
  discarded_or_low_confidence: string[];
  must_verify_in_source: boolean;
  is_authoritative: false;
}

// ---------------------------------------------------------------------------
// Keyword categories (case-insensitive, whole-word matching)
// ---------------------------------------------------------------------------

export const ERROR_KEYWORDS = [
  "error", "fail", "fatal", "critical", "exception", "timeout",
  "denied", "refused", "crash", "panic", "abort", "violation",
  "invalid", "unauthorized", "forbidden", "missing", "cannot", "unable",
] as const;

export const WARN_KEYWORDS = [
  "warn", "warning", "deprecated", "obsolete",
] as const;

const SUCCESS_KEYWORDS = [
  "success", "complete", "done", "finished", "ok", "ready",
  "started", "connected",
] as const;

// Pre-compiled category regexes — built once at module load.
const buildCategoryRegex = (words: readonly string[]): RegExp =>
  new RegExp(`\\b(?:${words.join("|")})\\b`, "i");

const ERROR_RE = buildCategoryRegex(ERROR_KEYWORDS);
const WARN_RE = buildCategoryRegex(WARN_KEYWORDS);
const SUCCESS_RE = buildCategoryRegex(SUCCESS_KEYWORDS);

// ---------------------------------------------------------------------------
// Extraction regexes (paths, URLs, timestamps, IPs)
// ---------------------------------------------------------------------------

// POSIX paths: /usr/bin, /Users/name/file.txt
const POSIX_PATH_RE = /\b\/[\w\/.\-]+/g;
// URLs
const URL_RE = /\bhttps?:\/\/[^\s]+/g;
// Timestamps: 2024-01-15T14:30:00 or 2024-01-15 14:30
const TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/g;
// IP addresses (v4 dotted-decimal)
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// Large numbers (>= 1000): counts, IDs, sizes — count only
const LARGE_NUM_RE = /\b\d{4,}\b/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ScoredLine {
  index: number;
  line: string;
  score: number;
}

/**
 * Assign an importance score to a single line.
 * Error/critical = 3, warning = 2, success/completion = 1, no match = 0.
 */
export function scoreLine(line: string): number {
  if (ERROR_RE.test(line)) return 3;
  if (WARN_RE.test(line)) return 2;
  if (SUCCESS_RE.test(line)) return 1;
  return 0;
}

/** Count matches of `re` in `text`. */
function countMatches(text: string, re: RegExp): number {
  // Clone the regex so we don't share lastIndex state.
  const r = new RegExp(re.source, re.flags);
  let count = 0;
  while (r.exec(text) !== null) {
    count++;
  }
  return count;
}

/** Collect unique matches of `re` in `text`. */
export function collectMatches(text: string, re: RegExp): string[] {
  const r = new RegExp(re.source, re.flags);
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    seen.add(m[0]);
  }
  return [...seen];
}

/** Check if a candidate looks like a real IP (each octet 0-255). */
function looksLikeIP(s: string): boolean {
  return s.split(".").every((octet) => {
    const n = Number(octet);
    return n >= 0 && n <= 255;
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function compressTextFallback(
  text: string,
  label: string,
  maxChars?: number,
): FallbackCompressResult {
  const limit = maxChars ?? 80_000;
  const originalLength = text.length;

  logger.debug(`compressTextFallback: label="${label}", inputLen=${originalLength}, maxChars=${limit}`);

  // ---- 1. Handle empty text ----
  if (!text || text.trim().length === 0) {
    return {
      summary: `Text from '${label}': empty input.`,
      key_facts: ["Input was empty — no content to analyze."],
      discarded_or_low_confidence: [
        "Full text content not semantically analyzed — pattern matching only",
        "Input was empty or whitespace-only",
      ],
      must_verify_in_source: true,
      is_authoritative: false as const,
    };
  }

  // ---- 2. Truncate ----
  const truncated = originalLength > limit;
  const workingText = truncated ? text.slice(0, limit) : text;

  // ---- 3. Split into lines ----
  const allLines = workingText.split(/\r?\n/);
  const nonEmptyLines = allLines.filter((l) => l.trim().length > 0);
  const totalLines = allLines.length;
  const totalChars = workingText.length;
  const nonEmptyCount = nonEmptyLines.length;
  const avgLineLen =
    nonEmptyCount > 0
      ? Math.round(nonEmptyLines.reduce((sum, l) => sum + l.length, 0) / nonEmptyCount)
      : 0;

  // ---- 4. Extract high-signal lines ----
  const scored: ScoredLine[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const s = scoreLine(allLines[i]);
    if (s > 0) {
      scored.push({ index: i, line: allLines[i].trim(), score: s });
    }
  }

  // Sort by score descending, then by original index (stable sort via index tie-break).
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  // Keep up to 20, then restore original order, deduplicate.
  const top20 = scored.slice(0, 20);
  top20.sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const keyFactLines: string[] = [];
  for (const item of top20) {
    const trimmed = item.line;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      keyFactLines.push(trimmed);
    }
  }

  // Count error/warning lines
  let errorCount = 0;
  let warnCount = 0;
  for (const line of allLines) {
    if (ERROR_RE.test(line)) errorCount++;
    else if (WARN_RE.test(line)) warnCount++;
  }

  // ---- 5. Extract paths, URLs, etc. ----
  const paths = collectMatches(workingText, POSIX_PATH_RE);
  const pathCount = paths.length;

  const urls = collectMatches(workingText, URL_RE);
  const urlCount = urls.length;

  const largeNumCount = countMatches(workingText, LARGE_NUM_RE);

  const timestamps = collectMatches(workingText, TIMESTAMP_RE);
  const timestampCount = timestamps.length;

  const rawIpMatches = collectMatches(workingText, IP_RE);
  const ips = rawIpMatches.filter(looksLikeIP);
  const ipCount = ips.length;

  // ---- 6. Build summary ----
  const truncationNote = truncated ? " Input was truncated." : "";
  const summary =
    `Text from '${label}': ${totalLines} lines, ${totalChars} chars. ` +
    `${errorCount} error/fatal lines, ${warnCount} warnings. ` +
    `${pathCount} file paths, ${urlCount} URLs detected.` +
    truncationNote;

  // ---- 7. Build key_facts ----
  const key_facts: string[] = [];

  // Statistical facts first
  key_facts.push(`Total: ${totalLines} lines, ${totalChars} chars`);
  key_facts.push(`Non-empty lines: ${nonEmptyCount}, average line length: ${avgLineLen} chars`);

  if (errorCount > 0) {
    key_facts.push(`${errorCount} error-level message(s) found (error/fatal/critical/exception/timeout/denied/refused/crash/panic/abort/violation/invalid/unauthorized/forbidden/missing/cannot/unable)`);
  }
  if (warnCount > 0) {
    key_facts.push(`${warnCount} warning(s) found (warn/warning/deprecated/obsolete)`);
  }
  if (largeNumCount > 0) {
    key_facts.push(`${largeNumCount} large number(s) detected (>= 1000)`);
  }
  if (timestampCount > 0) {
    key_facts.push(`${timestampCount} timestamp(s) detected`);
  }
  if (ipCount > 0) {
    key_facts.push(`${ipCount} IP address(es) detected`);
  }

  // Then the high-signal lines
  if (keyFactLines.length > 0) {
    key_facts.push(`--- High-signal lines (${keyFactLines.length}) ---`);
    for (const fact of keyFactLines) {
      key_facts.push(fact);
    }
  } else {
    key_facts.push("No high-signal keyword lines found in input.");
  }

  // ---- 8. Build discarded_or_low_confidence ----
  const discarded: string[] = [
    "Full text content not semantically analyzed — pattern matching only",
    "Lines without signal keywords were discarded",
  ];

  if (truncated) {
    discarded.push(
      `Input truncated from ${originalLength} to ${limit} chars`,
    );
  }

  discarded.push("Non-text content (if any) not parsed");

  logger.debug(
    `compressTextFallback done: lines=${totalLines}, errors=${errorCount}, warns=${warnCount}, keyFacts=${keyFactLines.length}`,
  );

  return {
    summary,
    key_facts,
    discarded_or_low_confidence: discarded,
    must_verify_in_source: true,
    is_authoritative: false as const,
  };
}
