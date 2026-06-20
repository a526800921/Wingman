/**
 * Heuristic per-file diff reviewer.
 * Uses chunking framework to split diff by file, then applies existing
 * pattern-based detection per file.
 */

import { chunkDiff } from "../chunking/diff.js";
import type { InputChunk, ChunkMeta } from "../chunking/types.js";
import { logger } from "../logger.js";
import { parseHunks } from "./review-diff.js";

export interface FileReview {
  file: string;
  change_summary: string;
  findings: Array<{
    risk: string;
    severity: "low" | "medium" | "high" | "critical";
    file: string;
    hunk?: string;
    location?: string;
    explanation?: string;
    evidence: string;
    introduced_by_diff?: boolean;
    confidence: "low" | "medium" | "high";
  }>;
  suggested_source_checks: string[];
  suggested_tests: string[];
  uncertainties: Array<{
    topic: string;
    reason: string;
    suggested_verification?: string;
  }>;
}

export interface ReviewDiffByFileFallbackResult {
  overall_summary: string;
  files: FileReview[];
  top_risks: Array<{
    risk: string;
    severity: "low" | "medium" | "high" | "critical";
    file: string;
    hunk?: string;
    location?: string;
    explanation?: string;
    evidence: string;
    introduced_by_diff?: boolean;
    confidence: "low" | "medium" | "high";
  }>;
  omitted_files: Array<{ file: string; reason: string }>;
  is_authoritative: false;
  _meta: {
    chunking: ChunkMeta;
  };
}

function analyzeFileChunk(chunk: InputChunk): FileReview {
  const filePath = chunk.source ?? chunk.label;
  const addedLines = (chunk.text.match(/^\+[^+].*$/gm) ?? []).map(l => l.slice(1));
  const removedLines = (chunk.text.match(/^-[^-].*$/gm) ?? []).map(l => l.slice(1));
  const hunks = parseHunks(chunk.text);
  const findings: FileReview["findings"] = [];
  const addedText = addedLines.join("\n");

  // Secret patterns
  const secretPatterns: Record<string, RegExp> = {
    password: /password\s*[:=]\s*['"][^'"]+['"]/i,
    secret: /(secret|api_secret|client_secret)\s*[:=]\s*['"][^'"]+['"]/i,
    token: /(token|access_token|auth_token)\s*[:=]\s*['"][^'"]+['"]/i,
    api_key: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
  };

  for (const [label, regex] of Object.entries(secretPatterns)) {
    if (regex.test(addedText)) {
      findings.push({
        risk: `Hardcoded ${label} detected`,
        severity: "critical",
        file: filePath,
        evidence: `Pattern /${label}/ matched in added lines`,
        introduced_by_diff: true,
        confidence: chunk.truncated ? "medium" : "high",
      });
    }
  }

  // Auth removal
  if (/\b(auth(?:enticate|orize|orisation)?|permission|validate)\b/i.test(removedLines.join("\n"))) {
    findings.push({
      risk: "Auth-related code removed",
      severity: "high",
      file: filePath,
      evidence: "Auth keyword(s) found in removed lines",
      introduced_by_diff: false,
      confidence: "medium",
    });
  }

  // SQL injection
  if (/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(addedText) &&
      /['"]\s*[+]\s*|`\$\{|format\(/.test(addedText)) {
    findings.push({
      risk: "Potential SQL injection via string concatenation",
      severity: "critical",
      file: filePath,
      evidence: "SQL keyword + string concatenation detected",
      introduced_by_diff: true,
      confidence: chunk.truncated ? "medium" : "high",
    });
  }

  // Empty catch
  if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*(\/\/.*)?\s*\}/g.test(addedText)) {
    findings.push({
      risk: "Empty catch block(s) detected",
      severity: "high",
      file: filePath,
      evidence: "Empty catch block pattern matched",
      introduced_by_diff: true,
      confidence: chunk.truncated ? "medium" : "high",
    });
  }

  // Command injection
  const cmdPattern = /\b(exec|spawn|eval|system|shell_exec|child_process)\s*\(/g;
  if (cmdPattern.test(addedText)) {
    const hasUserInput = /\b(req\.|request\.|params|query|body|input|argv)\b/i.test(addedText);
    findings.push({
      risk: `Command execution call added${hasUserInput ? " with potential user-controlled input" : ""}`,
      severity: hasUserInput ? "critical" : "high",
      file: filePath,
      evidence: "Command execution pattern detected",
      introduced_by_diff: true,
      confidence: chunk.truncated ? "medium" : "high",
    });
  }

  // Console.log left in
  if (/console\.(log|error|warn|debug|info)\(/.test(addedText)) {
    findings.push({
      risk: "Debug output left in code",
      severity: "medium",
      file: filePath,
      evidence: "console.log pattern matched in added lines",
      introduced_by_diff: true,
      confidence: "medium",
    });
  }

  const additions = addedLines.length;
  if (additions > 50) {
    findings.push({
      risk: `Large block of added code (${additions}+ lines)`,
      severity: "medium",
      file: filePath,
      evidence: `${additions} added lines in ${filePath}`,
      introduced_by_diff: true,
      confidence: "medium",
    });
  }

  const change_summary = `${filePath}: ${additions} addition(s), ${removedLines.length} deletion(s), ${hunks.length} hunk(s)`;

  return {
    file: filePath,
    change_summary,
    findings,
    suggested_source_checks: [`${filePath}: Review for correctness and style`],
    suggested_tests: [`Run existing tests for ${filePath}`],
    uncertainties: chunk.truncated
      ? [{ topic: "File truncated", reason: "File chunk was truncated — analysis incomplete" }]
      : [],
  };
}

export function reviewDiffByFileFallback(
  diff: string,
  maxCharsPerFile: number = 40_000,
  maxFiles: number = 30,
): ReviewDiffByFileFallbackResult {
  logger.debug("reviewDiffByFileFallback called", { diffLength: diff.length, maxCharsPerFile, maxFiles });

  if (!diff || diff.trim().length === 0) {
    return {
      overall_summary: "No changes detected",
      files: [],
      top_risks: [],
      omitted_files: [],
      is_authoritative: false,
      _meta: {
        chunking: {
          total_chunks: 0, analyzed_chunks: 0, omitted_chunks: 0,
          omitted: [], input_truncated: false, chunking_strategy: "diff-by-file-then-hunk",
        },
      },
    };
  }

  const { chunks, meta } = chunkDiff(diff, { max_chars_per_file: maxCharsPerFile, max_files: maxFiles });

  const fileReviews: FileReview[] = [];
  for (const chunk of chunks) {
    const review = analyzeFileChunk(chunk);
    const existing = fileReviews.find(f => f.file === review.file);
    if (existing) {
      existing.findings.push(...review.findings);
      existing.change_summary += "; " + review.change_summary;
      existing.suggested_source_checks.push(...review.suggested_source_checks);
      existing.suggested_tests.push(...review.suggested_tests);
      existing.uncertainties.push(...review.uncertainties);
    } else {
      fileReviews.push(review);
    }
  }

  const allFindings = fileReviews.flatMap(fr => fr.findings);
  allFindings.sort((a, b) => {
    const sev: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return (sev[a.severity] ?? 99) - (sev[b.severity] ?? 99);
  });
  const topRisks = allFindings.slice(0, 10);

  const omittedFiles = meta.omitted.map(o => ({ file: o.source ?? o.label, reason: o.reason }));

  const overallSummary =
    `Review of ${fileReviews.length} file(s) across ${chunks.length} chunk(s). ` +
    `${allFindings.length} finding(s) total. ` +
    (meta.omitted.length > 0 ? `${meta.omitted.length} file(s) omitted.` : "");

  return { overall_summary: overallSummary, files: fileReviews, top_risks: topRisks, omitted_files: omittedFiles, is_authoritative: false, _meta: { chunking: meta } };
}
