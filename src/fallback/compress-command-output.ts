/**
 * Heuristic command output compressor.
 * Recognizes common command output formats and extracts structured findings.
 */

import { detectOutputKind } from "../chunking/command-output.js";
import { logger } from "../logger.js";

export interface CommandOutputFinding {
  kind: "test_failure" | "type_error" | "lint_error" | "build_error" | "runtime_exception" | "warning" | "info" | "unknown";
  message: string;
  error_code?: string;
  rule_id?: string;
  file?: string;
  line?: number;
  column?: number;
  evidence: string;
  confidence: "low" | "medium" | "high";
  first_seen_index?: number;
}

export interface CompressCommandOutputFallbackResult {
  summary: string;
  first_failure?: CommandOutputFinding;
  findings: CommandOutputFinding[];
  repeated_errors: Array<{ message: string; count: number; examples: string[] }>;
  suggested_source_checks: string[];
  suggested_next_commands: string[];
  discarded_or_low_confidence: string[];
  is_authoritative: false;
}

function extractTscErrors(output: string): CommandOutputFinding[] {
  const findings: CommandOutputFinding[] = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(output)) !== null) {
    findings.push({
      kind: "type_error",
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      error_code: match[4],
      message: match[5].trim(),
      evidence: match[0],
      confidence: "high",
      first_seen_index: match.index,
    });
  }
  return findings;
}

function extractEslintErrors(output: string): CommandOutputFinding[] {
  const findings: CommandOutputFinding[] = [];
  const re = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(output)) !== null) {
    findings.push({
      kind: match[3] === "error" ? "lint_error" : "warning",
      line: Number(match[1]),
      column: Number(match[2]),
      message: match[4].trim(),
      rule_id: match[5],
      evidence: match[0].trim(),
      confidence: "high",
      first_seen_index: match.index,
    });
  }
  return findings;
}

function extractTestFailures(output: string): CommandOutputFinding[] {
  const findings: CommandOutputFinding[] = [];
  const failBlockRe = /FAIL\s+(.+?)\n([\s\S]*?)(?=\n\s*(?:FAIL|Tests:)|$)/g;
  let match: RegExpExecArray | null;
  while ((match = failBlockRe.exec(output)) !== null) {
    const testFile = match[1];
    const block = match[2];
    const testNameRe = /[×✗✘]\s+(.+?)(?=\n|$)/g;
    let tnMatch: RegExpExecArray | null;
    while ((tnMatch = testNameRe.exec(block)) !== null) {
      findings.push({
        kind: "test_failure",
        file: testFile,
        message: tnMatch[1].trim(),
        evidence: tnMatch[0].trim(),
        confidence: "high",
        first_seen_index: tnMatch.index,
      });
    }
  }
  return findings;
}

function extractStackTraces(output: string): CommandOutputFinding[] {
  const findings: CommandOutputFinding[] = [];
  const errorRe = /^(\w+(?:Error|Exception|Panic|Fault)):\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = errorRe.exec(output)) !== null) {
    const errorType = match[1];
    const message = match[2]?.trim() ?? "";
    const afterMatch = output.slice(match.index);
    const frameRe = /\n\s+at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/g;
    let frameMatch = frameRe.exec(afterMatch);
    while (frameMatch && frameMatch[2]?.includes("node_modules")) {
      frameMatch = frameRe.exec(afterMatch);
    }
    findings.push({
      kind: "runtime_exception",
      message: `${errorType}: ${message}`,
      error_code: errorType,
      file: frameMatch?.[2],
      line: frameMatch ? Number(frameMatch[3]) : undefined,
      column: frameMatch ? Number(frameMatch[4]) : undefined,
      evidence: match[0] + (frameMatch ? `\n    at ${frameMatch[1]} (${frameMatch[2]}:${frameMatch[3]}:${frameMatch[4]})` : ""),
      confidence: "high",
      first_seen_index: match.index,
    });
  }
  return findings;
}

function sanitizeEvidence(text: string): string {
  return text
    .replace(/Bearer\s+[\w\-.]{20,}/gi, "Bearer ***REDACTED***")
    .replace(/(api[_-]?key|apikey|secret|token|password)\s*[:=]\s*['"]?[\w\-.]{8,}['"]?/gi, "$1=***REDACTED***")
    .replace(/(https?:\/\/)[^:@]+:[^@]+@/g, "$1***:***@");
}

function mergeRepeatedErrors(findings: CommandOutputFinding[]): CompressCommandOutputFallbackResult["repeated_errors"] {
  const counts = new Map<string, { count: number; examples: string[] }>();
  for (const f of findings) {
    const key = f.message.toLowerCase().trim();
    const entry = counts.get(key);
    if (entry) {
      entry.count++;
      if (entry.examples.length < 3) entry.examples.push(f.evidence);
    } else {
      counts.set(key, { count: 1, examples: [f.evidence] });
    }
  }
  const repeated: CompressCommandOutputFallbackResult["repeated_errors"] = [];
  for (const [message, info] of counts) {
    if (info.count > 1) repeated.push({ message, count: info.count, examples: info.examples });
  }
  repeated.sort((a, b) => b.count - a.count);
  return repeated;
}

function extractGenericFindings(output: string): CommandOutputFinding[] {
  const findings: CommandOutputFinding[] = [];
  const lines = output.split(/\r?\n/);
  const errorRe = /\b(ERROR|FATAL|CRITICAL|PANIC)\b/i;
  const warnRe = /\b(WARN|WARNING)\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (errorRe.test(lines[i])) {
      const ctxStart = Math.max(0, i - 2);
      const ctxEnd = Math.min(lines.length, i + 3);
      findings.push({
        kind: "unknown",
        message: lines[i].trim(),
        evidence: lines.slice(ctxStart, ctxEnd).join("\n"),
        confidence: "medium",
        first_seen_index: i,
      });
    } else if (warnRe.test(lines[i])) {
      findings.push({
        kind: "warning",
        message: lines[i].trim(),
        evidence: lines[i],
        confidence: "medium",
        first_seen_index: i,
      });
    }
  }
  return findings;
}

export function compressCommandOutputFallback(
  command: string | undefined,
  output: string,
  exitCode: number | undefined,
  maxChars: number = 120_000,
): CompressCommandOutputFallbackResult {
  logger.debug("compressCommandOutputFallback called", { command, outputLen: output.length, exitCode, maxChars });

  const kind = detectOutputKind(output);
  let findings: CommandOutputFinding[] = [];

  switch (kind) {
    case "tsc_error": findings = extractTscErrors(output); break;
    case "eslint_output": findings = extractEslintErrors(output); break;
    case "test_output": findings = extractTestFailures(output); break;
    case "stack_trace": findings = extractStackTraces(output); break;
    default: findings = extractGenericFindings(output); break;
  }

  for (const f of findings) f.evidence = sanitizeEvidence(f.evidence);

  // Deduplicate
  const seen = new Set<string>();
  const deduped: CommandOutputFinding[] = [];
  for (const f of findings) {
    const key = `${f.kind}:${f.file ?? ""}:${f.line ?? ""}:${f.message}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(f); }
  }

  deduped.sort((a, b) => (a.first_seen_index ?? 0) - (b.first_seen_index ?? 0));
  const firstFailure = deduped.find(f =>
    f.kind === "test_failure" || f.kind === "type_error" || f.kind === "build_error" || f.kind === "runtime_exception"
  );

  const repeatedErrors = mergeRepeatedErrors(deduped);

  const errorCount = deduped.filter(f => f.kind !== "warning" && f.kind !== "info").length;
  const warnCount = deduped.filter(f => f.kind === "warning").length;
  const commandLabel = command ? `Command \`${command}\` ` : "";
  const exitLabel = exitCode !== undefined ? ` (exit code: ${exitCode})` : "";
  const summary =
    `${commandLabel}${exitLabel}: Detected "${kind}". ` +
    `${errorCount} error(s), ${warnCount} warning(s). ` +
    (firstFailure ? `First failure: ${firstFailure.message}. ` : "") +
    (repeatedErrors.length > 0 ? `${repeatedErrors.length} repeated error pattern(s).` : "");

  const suggestedChecks: string[] = [];
  for (const f of deduped.slice(0, 5)) {
    if (f.file) suggestedChecks.push(`Check ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`);
  }

  const suggestedCommands: string[] = [];
  if (kind === "tsc_error") suggestedCommands.push("npx tsc --noEmit");
  if (kind === "test_output") suggestedCommands.push("Run the specific failing test file with verbose output");
  if (kind === "eslint_output") suggestedCommands.push("npx eslint <files>");

  const discarded: string[] = ["Full output not semantically analyzed — pattern matching only"];
  if (output.length > maxChars) discarded.push(`Output truncated from ${output.length} to ${maxChars} chars`);

  return { summary, first_failure: firstFailure, findings: deduped, repeated_errors: repeatedErrors, suggested_source_checks: suggestedChecks, suggested_next_commands: suggestedCommands, discarded_or_low_confidence: discarded, is_authoritative: false };
}
