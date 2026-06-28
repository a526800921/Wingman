/**
 * aux_report_tool_feedback MCP tool handler.
 *
 * Collects structured quality feedback from a calling model about a prior
 * Wingman tool output.  The handler writes one JSONL line to a local feedback
 * log and NEVER calls a model itself (plan invariant #2).
 *
 * File writing is best-effort: any I/O error is silently caught so a
 * failing log never breaks the MCP call.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { validateInput } from "../schema.js";
import type { ToolFeedbackInput, ToolFeedbackOutput } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successResult(payload: ToolFeedbackOutput): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
  };
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

/**
 * Handle the `aux_report_tool_feedback` MCP tool call.
 *
 * Flow:
 * 1. Validate input against ToolFeedbackInputSchema (length limits +
 *    sensitive-content rejection).
 * 2. Generate a feedback_id (fb_YYYYMMDD_XXXXXX).
 * 3. Determine the log file path from AUX_FEEDBACK_LOG_FILE (default:
 *    .aux-feedback.jsonl in cwd).  When set to "off", "false", or the empty
 *    string, the write is skipped and recorded is returned as false.
 * 4. Append one JSONL line to the log file.
 * 5. Catch every I/O error — the handler never throws from file writes.
 * 6. Return a structured CallToolResult.
 */
export async function handleReportToolFeedback(
  input: unknown,
  _config: unknown,
): Promise<CallToolResult> {
  // ---- Step 1: validate input ----------------------------------------------
  const validation = validateInput("aux_report_tool_feedback", input);
  if (!validation.ok) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid input: ${validation.error}`);
  }
  const data = validation.data as ToolFeedbackInput;

  // ---- Step 2: generate feedback_id ----------------------------------------
  const now = new Date();
  const dateStr = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const randomHex = randomBytes(3).toString("hex"); // 6 hex chars
  const feedbackId = `fb_${dateStr}_${randomHex}`;

  // ---- Step 3: determine log file path -------------------------------------
  const envPath = process.env.AUX_FEEDBACK_LOG_FILE;

  if (envPath === "off" || envPath === "false" || envPath === "") {
    return successResult({
      recorded: false,
      feedback_id: feedbackId,
      log_file: null,
      is_authoritative: false as const,
    });
  }

  const logFile = envPath ? resolve(envPath) : resolve(process.cwd(), ".aux-feedback.jsonl");

  // ---- Step 4: build JSONL entry -------------------------------------------
  const entry: Record<string, unknown> = {
    feedback_id: feedbackId,
    timestamp: now.toISOString(),
    tool_name: data.tool_name,
    issue_category: data.issue_category,
    severity: data.severity,
    summary: data.summary,
    confidence: data.confidence,
  };

  // Optional fields — only serialised when present
  if (data.trace_id !== undefined) entry.trace_id = data.trace_id;
  if (data.evidence !== undefined) entry.evidence = data.evidence;
  if (data.expected_behavior !== undefined) entry.expected_behavior = data.expected_behavior;
  if (data.actual_behavior !== undefined) entry.actual_behavior = data.actual_behavior;

  // ---- Step 5: write JSONL (best-effort) -----------------------------------
  let recorded = false;
  let resolvedLogFile: string | null = null;

  try {
    const dir = dirname(logFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
    recorded = true;
    resolvedLogFile = logFile;
  } catch {
    // File write failed — never throw. The caller still gets a valid result.
    resolvedLogFile = null;
  }

  // ---- Step 6: return ------------------------------------------------------
  return successResult({
    recorded,
    feedback_id: feedbackId,
    log_file: resolvedLogFile,
    is_authoritative: false as const,
  });
}
