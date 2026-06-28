#!/usr/bin/env node

/**
 * Feedback Aggregation Script
 *
 * Reads `.aux-feedback.jsonl` (or a specified input file) and generates a
 * markdown summary report in the specified output directory.
 *
 * Usage:
 *   npx tsx scripts/summarize-feedback.ts [options]
 *
 * Options:
 *   --input <path>   Path to the JSONL feedback file (default: .aux-feedback.jsonl)
 *   --output <dir>   Output directory for the report (default: docs/feedback/)
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeedbackEntry {
  feedback_id: string;
  timestamp: string;
  tool_name: string;
  trace_id?: string;
  issue_category: string;
  severity: string;
  summary: string;
  evidence?: string;
  expected_behavior?: string;
  actual_behavior?: string;
  confidence: string;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { input: string; outputDir: string } {
  const args = process.argv.slice(2);
  let input = ".aux-feedback.jsonl";
  let outputDir = "docs/feedback";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && i + 1 < args.length) {
      input = args[++i];
    } else if (args[i] === "--output" && i + 1 < args.length) {
      outputDir = args[++i];
    }
  }

  return { input, outputDir };
}

// ---------------------------------------------------------------------------
// JSONL reading and parsing
// ---------------------------------------------------------------------------

function readFeedbackEntries(filePath: string): FeedbackEntry[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const entries: FeedbackEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    try {
      const parsed = JSON.parse(lines[i]);
      // Basic validity check — must have required fields
      if (
        typeof parsed.feedback_id !== "string" ||
        typeof parsed.timestamp !== "string" ||
        typeof parsed.tool_name !== "string" ||
        typeof parsed.issue_category !== "string" ||
        typeof parsed.severity !== "string" ||
        typeof parsed.summary !== "string" ||
        typeof parsed.confidence !== "string"
      ) {
        console.warn(
          `Warning (line ${lineNum}): Skipping malformed entry — missing required fields`,
        );
        continue;
      }
      entries.push(parsed as FeedbackEntry);
    } catch {
      console.warn(
        `Warning (line ${lineNum}): Skipping malformed line — invalid JSON`,
      );
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Report generation helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "000Z");
}

function escapeMd(text: string | undefined): string {
  if (text === undefined || text === null) return "*not provided*";
  return text.replace(/\|/g, "\\|");
}

// ---------------------------------------------------------------------------
// Aggregation logic
// ---------------------------------------------------------------------------

interface CategoryCount {
  category: string;
  count: number;
}

function aggregateByTool(entries: FeedbackEntry[]): CategoryCount[] {
  const map = new Map<string, number>();
  for (const e of entries) {
    map.set(e.tool_name, (map.get(e.tool_name) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

function aggregateByCategory(entries: FeedbackEntry[]): CategoryCount[] {
  const map = new Map<string, number>();
  for (const e of entries) {
    map.set(e.issue_category, (map.get(e.issue_category) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

function getHighCriticalEntries(entries: FeedbackEntry[]): FeedbackEntry[] {
  return entries
    .filter((e) => e.severity === "high" || e.severity === "critical")
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
}

interface DuplicateCluster {
  summary: string;
  count: number;
  entries: FeedbackEntry[];
}

function clusterDuplicates(entries: FeedbackEntry[]): DuplicateCluster[] {
  const map = new Map<string, FeedbackEntry[]>();
  for (const e of entries) {
    const existing = map.get(e.summary) ?? [];
    existing.push(e);
    map.set(e.summary, existing);
  }
  return [...map.entries()]
    .filter(([_, entries]) => entries.length > 1)
    .map(([summary, entries]) => ({ summary, count: entries.length, entries }))
    .sort((a, b) => b.count - a.count);
}

function getFixtureCandidates(entries: FeedbackEntry[]): FeedbackEntry[] {
  const severityRank: Record<string, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  const confidenceRank: Record<string, number> = {
    low: 0,
    medium: 1,
    high: 2,
  };

  return entries
    .filter(
      (e) =>
        (severityRank[e.severity] ?? 0) >= 1 &&
        (confidenceRank[e.confidence] ?? 0) >= 1 &&
        e.trace_id !== undefined &&
        e.trace_id !== "" &&
        e.expected_behavior !== undefined &&
        e.expected_behavior !== "" &&
        e.actual_behavior !== undefined &&
        e.actual_behavior !== "",
    )
    .sort(
      (a, b) =>
        (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0) ||
        (confidenceRank[b.confidence] ?? 0) - (confidenceRank[a.confidence] ?? 0),
    );
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderReport(
  entries: FeedbackEntry[],
  inputFile: string,
): string {
  const now = new Date();
  const dateStr = formatDate(now);

  // Compute date range from entries
  const timestamps = entries
    .map((e) => e.timestamp)
    .filter(Boolean)
    .sort();
  const periodStart =
    timestamps.length > 0 ? timestamps[0].slice(0, 10) : dateStr;
  const periodEnd =
    timestamps.length > 0
      ? timestamps[timestamps.length - 1].slice(0, 10)
      : dateStr;

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────
  lines.push(`# Wingman Feedback Summary — ${dateStr}`);
  lines.push("");
  lines.push("## Overview");
  lines.push(`- Total feedback entries: ${entries.length}`);
  lines.push(`- Period: ${periodStart} to ${periodEnd}`);
  lines.push(`- Source: ${inputFile}`);
  lines.push("");

  // ── By Tool ─────────────────────────────────────────────
  lines.push("## By Tool");
  lines.push("| Tool | Count |");
  lines.push("|---|---|");
  const byTool = aggregateByTool(entries);
  if (byTool.length === 0) {
    lines.push("| _(none)_ | 0 |");
  } else {
    for (const { category, count } of byTool) {
      lines.push(`| ${escapeMd(category)} | ${count} |`);
    }
  }
  lines.push("");

  // ── By Category ─────────────────────────────────────────
  lines.push("## By Category");
  lines.push("| Category | Count |");
  lines.push("|---|---|");
  const byCategory = aggregateByCategory(entries);
  if (byCategory.length === 0) {
    lines.push("| _(none)_ | 0 |");
  } else {
    for (const { category, count } of byCategory) {
      lines.push(`| ${escapeMd(category)} | ${count} |`);
    }
  }
  lines.push("");

  // ── High / Critical Issues ──────────────────────────────
  const highCritical = getHighCriticalEntries(entries);
  lines.push("## High / Critical Issues");
  if (highCritical.length === 0) {
    lines.push("");
    lines.push("No high or critical severity issues found.");
    lines.push("");
  } else {
    lines.push("");
    for (const entry of highCritical) {
      lines.push(
        `### [${entry.severity}] ${escapeMd(entry.tool_name)} — ${escapeMd(entry.issue_category)}`,
      );
      lines.push("");
      lines.push(`- **Feedback ID:** ${entry.feedback_id}`);
      lines.push(`- **Timestamp:** ${entry.timestamp}`);
      lines.push(`- **Summary:** ${escapeMd(entry.summary)}`);
      lines.push(
        `- **Evidence:** ${escapeMd(entry.evidence ?? "*not provided*")}`,
      );
      lines.push(
        `- **Expected:** ${escapeMd(entry.expected_behavior ?? "*not provided*")}`,
      );
      lines.push(
        `- **Actual:** ${escapeMd(entry.actual_behavior ?? "*not provided*")}`,
      );
      lines.push(`- **Trace ID:** ${escapeMd(entry.trace_id ?? "*not provided*")}`);
      lines.push("");
    }
  }

  // ── Duplicate Clustering ────────────────────────────────
  const clusters = clusterDuplicates(entries);
  lines.push("## Duplicate Clusters");
  if (clusters.length === 0) {
    lines.push("");
    lines.push("No duplicate summaries found.");
    lines.push("");
  } else {
    lines.push("");
    lines.push(
      `| Duplicate Summary | Occurrences | Tools | Severities | Trace IDs |`,
    );
    lines.push(
      `|---|---|---|---|---|`,
    );
    for (const cluster of clusters) {
      const tools = [
        ...new Set(cluster.entries.map((e) => e.tool_name)),
      ].join(", ");
      const severities = [
        ...new Set(cluster.entries.map((e) => e.severity)),
      ].join(", ");
      const traceIds = cluster.entries
        .map((e) => e.trace_id)
        .filter(Boolean)
        .join(", ");
      const summaryTrunc =
        cluster.summary.length > 80
          ? cluster.summary.slice(0, 77) + "..."
          : cluster.summary;
      lines.push(
        `| ${escapeMd(summaryTrunc)} | ${cluster.count} | ${escapeMd(tools)} | ${escapeMd(severities)} | ${escapeMd(traceIds || "*none*")} |`,
      );
    }
    lines.push("");
  }

  // ── Fixture Candidates ──────────────────────────────────
  const candidates = getFixtureCandidates(entries);
  lines.push("## Fixture Candidates");
  lines.push("");
  if (candidates.length === 0) {
    lines.push("No fixture candidates found.");
    lines.push("");
  } else {
    lines.push(`${candidates.length} candidate(s) found.`);
    lines.push("");
    candidates.forEach((entry, idx) => {
      lines.push(
        `### Candidate ${idx + 1}: [${escapeMd(entry.issue_category)}] on ${escapeMd(entry.tool_name)}`,
      );
      lines.push("");
      lines.push(`- **Severity:** ${entry.severity}`);
      lines.push(`- **Confidence:** ${entry.confidence}`);
      lines.push(`- **Summary:** ${escapeMd(entry.summary)}`);
      lines.push(`- **Feedback ID:** ${entry.feedback_id}`);
      lines.push(`- **Timestamp:** ${entry.timestamp}`);
      if (entry.trace_id) {
        lines.push(`- **Trace ID:** ${entry.trace_id}`);
      }
      lines.push(
        `- **Expected:** ${escapeMd(entry.expected_behavior ?? "*not provided*")}`,
      );
      lines.push(
        `- **Actual:** ${escapeMd(entry.actual_behavior ?? "*not provided*")}`,
      );
      lines.push("");
    });
  }

  // ── Footer ──────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push(
    `_Report generated at ${formatIso(now)} from ${path.basename(inputFile)}_`,
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { input, outputDir } = parseArgs();

  const inputPath = path.resolve(input);

  // Validate input file exists
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // Read and parse entries
  let entries: FeedbackEntry[];
  try {
    entries = readFeedbackEntries(inputPath);
  } catch (err) {
    console.error(
      `Error: Failed to read input file: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Generate report
  const report = renderReport(entries, inputPath);

  // Ensure output directory exists
  const outputDirPath = path.resolve(outputDir);
  fs.mkdirSync(outputDirPath, { recursive: true });

  // Write report
  const today = new Date();
  const dateStr = formatDate(today);
  const outputFileName = `feedback-summary-${dateStr}.md`;
  const outputPath = path.join(outputDirPath, outputFileName);
  fs.writeFileSync(outputPath, report, "utf-8");

  console.log(`Feedback summary written to: ${outputPath}`);
  console.log(`Total entries processed: ${entries.length}`);
}

main();
