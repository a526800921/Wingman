import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { hasModelConfig, loadConfig, loadConfigFallback } from "../config.js";
import { ChatClient } from "../chat-client.js";
import {
  validateInput,
  validateOutput,
  ModelCommandOutputResponseSchema,
  type ModelFirstFinding,
  type CompressCommandOutputInput,
  type CompressCommandOutputOutput,
} from "../schema.js";
import {
  buildCompressCommandOutputSystemPrompt,
  buildCompressCommandOutputBatchUserMessage,
  buildCompressCommandOutputUserMessage,
  buildModelFirstSystemPrompt,
  buildModelFirstUserMessage,
  extractJsonFromResponse,
} from "../prompts.js";
import {
  decodeModelFirstResponse,
  type ModelResponseStatus,
} from "../decoding/command-output-decoder.js";
import {
  compressCommandOutputFallback,
  type CommandOutputFinding,
} from "../fallback/compress-command-output.js";
import { chunkCommandOutput, detectOutputKind } from "../chunking/command-output.js";
import { deduplicateCommandFindings } from "../chunking/merge.js";
import { createTraceId, traceLogger, logDuration } from "../logger.js";

function sanitizeEvidence(text: string): string {
  return text
    .replace(/Bearer\s+[\w\-.]{20,}/gi, "Bearer ***REDACTED***")
    .replace(/(api[_-]?key|apikey|secret|token|password)\s*[:=]\s*['"]?[\w\-.]{8,}['"]?/gi, "$1=***REDACTED***")
    .replace(/(https?:\/\/)[^:@]+:[^@]+@/g, "$1***:***@");
}

type ConfigLike = ReturnType<typeof loadConfig> | ReturnType<typeof loadConfigFallback>;

function hasApiKey(config: ConfigLike): config is AppConfig {
  return "modelApiKey" in config && typeof (config as AppConfig).modelApiKey === "string" && (config as AppConfig).modelApiKey.length > 0;
}

// ── Batching config ───────────────────────────────────────

const BATCH_MAX_DIAGNOSTICS = 20;
const BATCH_MAX_CHARS = 6000;
const MAX_MODEL_CALLS = 5;
/** Characters below which we treat input as "small" and send in one call. */
const SINGLE_CALL_CHAR_BUDGET = 12000;

// ── Enrichment decision ───────────────────────────────────

type EnrichmentMode = "off" | "on";

function getEnrichmentMode(
  focus: string | undefined,
  outputKind: string,
  findings: CommandOutputFinding[],
): EnrichmentMode {
  if (focus && /\b(errors?\s*only|structure(d)?\s*only|list\s*only)\b/i.test(focus)) {
    return "off";
  }
  if (focus && /\b(root\s*cause|priority|impact|fix|explain|enrich|semantic)\b/i.test(focus)) {
    return "on";
  }
  if (outputKind === "tsc_error" && findings.length > 0 && findings.every(f => f._diagnostic_id)) {
    return "off";
  }
  if (outputKind === "generic_log") {
    return "on";
  }
  return "off";
}

// ── Evidence verification ─────────────────────────────────

type EvidenceVerdict = "verified" | "partial" | "unverified";

function verifyEvidence(evidence: string, inputText: string): EvidenceVerdict {
  if (!evidence || evidence.trim().length === 0) return "unverified";
  // Exact substring match
  if (inputText.includes(evidence)) return "verified";
  // Try line-by-line: any line of evidence found?
  const lines = evidence.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const matchedLines = lines.filter(l => inputText.includes(l));
  if (matchedLines.length >= lines.length * 0.5) return "partial";
  return "unverified";
}

function modelFindingToOutput(f: ModelFirstFinding, verdict: EvidenceVerdict): CommandOutputFinding {
  return {
    kind: f.kind,
    message: f.message,
    error_code: f.error_code,
    file: f.file,
    line: f.line,
    column: f.column,
    evidence: f.evidence,
    confidence: verdict === "unverified" ? "low" : verdict === "partial" ? "medium" : f.confidence,
    _diagnostic_id: f.finding_id,
    _model_verified: verdict,
  } as CommandOutputFinding & { _model_verified: string };
}

/** Extended finding with internal-only fields added by model-first path. */
type InternalFinding = CommandOutputFinding & { _model_verified?: string };

/** Strip internal-only fields (_diagnostic_id, _model_verified) before placing a finding into public output positions. */
function stripInternalFields(f: InternalFinding | undefined): CommandOutputFinding | undefined {
  if (!f) return undefined;
  const { _diagnostic_id, _model_verified, ...clean } = f;
  return clean as CommandOutputFinding;
}

/** Strip internal fields from every finding in an array. */
function stripInternalFieldsFromArray(findings: InternalFinding[]): CommandOutputFinding[] {
  return findings.map(f => {
    const { _diagnostic_id, _model_verified, ...clean } = f;
    return clean as CommandOutputFinding;
  });
}

// ── Main handler ───────────────────────────────────────────

export async function handleCompressCommandOutput(
  input: unknown,
  config: ConfigLike,
  _testClient?: ChatClient,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const tid = createTraceId();
  const log = traceLogger(tid);

  const validation = validateInput("aux_compress_command_output", input);
  if (!validation.ok) throw new McpError(ErrorCode.InvalidParams, validation.error);

  const validated = validation.data as CompressCommandOutputInput;
  const { command, output, exit_code, focus, max_chars = 120_000, analysis_mode = "model_first" } = validated;

  log.info("compress_command_output start", { command, outputLen: output.length, exit_code, analysis_mode });

  try { return await handleImpl(); }
  finally { logDuration(tid, "compress_command_output done", t0); }

  async function handleImpl(): Promise<CallToolResult> {
    const provider = (config as AppConfig).modelProvider ?? process.env.AUX_MODEL_PROVIDER ?? "remote";
    const modelAvailable = hasModelConfig() && hasApiKey(config);
    const detectorHint = detectOutputKind(output);
    const cappedOutput = output.length > max_chars ? output.slice(0, max_chars) : output;
    const inputTruncated = output.length > max_chars;

    // Mode: deterministic_only → skip model entirely
    if (analysis_mode === "deterministic_only" || !modelAvailable) {
      return fallbackOnlyResult(provider, cappedOutput, inputTruncated, command, exit_code, detectorHint);
    }

    const client = _testClient ?? new ChatClient(config as AppConfig);
    if (!client.isAvailable()) {
      log.info("compress-command-output: ChatClient unavailable, using fallback");
      return fallbackOnlyResult(provider, cappedOutput, inputTruncated, command, exit_code, detectorHint);
    }

    const modelName = (config as AppConfig).modelName;

    // ── Model-first path ────────────────────────────────
    if (analysis_mode === "model_first") {
      return await modelFirstPath(client, provider, modelName, cappedOutput, command, exit_code, focus, detectorHint, inputTruncated, log);
    }

    // ── Auto path (existing batch/parser hybrid) ─────────
    return await autoPath(client, provider, modelName, cappedOutput, command, exit_code, focus, detectorHint, inputTruncated, max_chars, log);
  }
}

// ── Model-first path ───────────────────────────────────────

async function modelFirstPath(
  client: ChatClient,
  provider: string,
  modelName: string,
  output: string,

  command: string | undefined,
  exitCode: number | undefined,
  focus: string | undefined,
  detectorHint: string,
  inputTruncated: boolean,
  log: ReturnType<typeof traceLogger>,
): Promise<CallToolResult> {
  const systemPrompt = buildModelFirstSystemPrompt();
  const userMsg = buildModelFirstUserMessage(output, command, exitCode, focus, detectorHint);

  // Single call for small inputs; batch for large
  let modelFindings: ModelFirstFinding[] = [];
  let modelDetectedKind: string | undefined;
  let modelSummary: string | undefined;
  let reportedTotals: CompressCommandOutputOutput["reported_totals"];
  let uncertainties: string[] = [];
  let batchesSent = 1;
  let batchesSucceeded = 0;
  let batchesFailed = 0;
  let modelFindingsReceived = 0;
  let modelFindingsRejected = 0;
  let modelResponseStatus: ModelResponseStatus = "transport_failure";
  let modelFailureReason: string | undefined;
  let modelCallAttempts = 0;

  if (output.length <= SINGLE_CALL_CHAR_BUDGET) {
    // ── Small input: single model call ────────────────────
    modelCallAttempts = 1;

    try {
      const raw = await client.chat(systemPrompt, userMsg);
      const decoded = decodeModelFirstResponse(raw);

      modelResponseStatus = decoded.status;
      modelDetectedKind = decoded.detected_kind;
      modelSummary = decoded.summary;
      reportedTotals = decoded.reported_totals as CompressCommandOutputOutput["reported_totals"];
      uncertainties = decoded.uncertainties ?? [];

      if (decoded.status === "valid" || decoded.status === "partial_valid") {
        batchesSucceeded = 1;
        modelFindings = decoded.accepted_findings;
        modelFindingsReceived = decoded.accepted_findings.length + decoded.rejected_issues.length;
        modelFindingsRejected = decoded.rejected_issues.length;
      } else if (decoded.status === "empty") {
        batchesSucceeded = 1;
        modelFindings = [];
        modelFindingsReceived = 0;
      } else {
        // parse_failure or schema_failure
        batchesFailed = 1;
        modelFailureReason = decoded.status === "parse_failure"
          ? "model response JSON parse failed"
          : "model response schema validation failed (envelope)";
        log.warn("compress-command-output: model-first decode failed", {
          status: decoded.status,
        });
      }
    } catch (err) {
      batchesFailed = 1;
      modelResponseStatus = "transport_failure";
      modelFailureReason = `model HTTP call failed: ${err instanceof Error ? err.message : String(err)}`;
      log.warn("compress-command-output: model-first call failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Non-zero exit recovery: 1 repair call ────────────
    if (
      exitCode !== undefined &&
      exitCode !== 0 &&
      batchesFailed > 0 &&
      batchesSucceeded === 0
    ) {
      log.info("compress-command-output: attempting repair call for non-zero exit");
      modelCallAttempts = 2;

      const repairSystemPrompt = buildModelFirstSystemPrompt() +
        "\n\nIMPORTANT: Your previous response was not valid JSON or did not match the required schema. " +
        "Ensure your response is valid JSON that strictly follows the OUTPUT SCHEMA. " +
        "Do NOT use null for optional fields — omit them entirely. " +
        "Do NOT add extra fields beyond the schema.";

      try {
        const repairRaw = await client.chat(repairSystemPrompt, userMsg);
        const repairDecoded = decodeModelFirstResponse(repairRaw);

        modelResponseStatus = repairDecoded.status;
        modelDetectedKind = repairDecoded.detected_kind ?? modelDetectedKind;
        modelSummary = repairDecoded.summary ?? modelSummary;
        reportedTotals = (repairDecoded.reported_totals as CompressCommandOutputOutput["reported_totals"]) ?? reportedTotals;
        uncertainties = repairDecoded.uncertainties ?? uncertainties;

        if (repairDecoded.status === "valid" || repairDecoded.status === "partial_valid") {
          batchesSucceeded = 1;
          batchesFailed = 0;
          modelFindings = repairDecoded.accepted_findings;
          modelFindingsReceived = repairDecoded.accepted_findings.length + repairDecoded.rejected_issues.length;
          modelFindingsRejected = repairDecoded.rejected_issues.length;
          modelFailureReason = undefined;
        } else if (repairDecoded.status === "empty") {
          batchesSucceeded = 1;
          batchesFailed = 0;
          modelFindings = [];
          modelFindingsReceived = 0;
          modelFailureReason = undefined;
        }
        // else: repair also failed — keep original failure state
      } catch (err) {
        log.warn("compress-command-output: repair call also failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    // Large input: chunk by generic boundaries, then batch
    return await autoPath(client, provider, modelName, output, command, exitCode, focus, detectorHint, inputTruncated, output.length, log);
  }

  // ── Evidence verification ──────────────────────────────
  const findings: CommandOutputFinding[] = [];

  for (const mf of modelFindings) {
    const verdict = verifyEvidence(mf.evidence, output);
    const finding = modelFindingToOutput(mf, verdict);
    finding.evidence = sanitizeEvidence(finding.evidence);
    findings.push(finding);
  }

  // Dedup by finding_id only
  const seenIds = new Set<string>();
  const dedupedFindings = findings.filter(f => {
    const id = f._diagnostic_id;
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });

  // Count from final canonical set (post-dedup)
  let verifiedCount = 0;
  let partialCount = 0;
  let unverifiedCount = 0;
  for (const f of dedupedFindings) {
    const v = (f as InternalFinding)._model_verified;
    if (v === "verified") verifiedCount++;
    else if (v === "partial") partialCount++;
    else unverifiedCount++;
  }

  // ── Non-zero exit + no verified findings → incomplete or fallback ──
  let analysisStatus: CompressCommandOutputOutput["analysis_status"] = "complete";
  const discarded: string[] = [];
  let fallbackUsed = false;

  // Determine if we need to use deterministic coverage guard
  const allFindingsRejected = modelFindingsReceived > 0 && modelFindings.length === 0;
  const modelFailed = batchesFailed > 0 && batchesSucceeded === 0;
  const needsCoverageGuard =
    modelFailed ||
    modelResponseStatus === "empty" ||
    allFindingsRejected;

  if (exitCode !== undefined && exitCode !== 0 && verifiedCount === 0) {
    if (needsCoverageGuard) {
      // Model failed / empty / all-rejected — try deterministic fallback for known formats
      if (modelFailed) {
        analysisStatus = "incomplete";
        discarded.push("Model analysis failed — results may be incomplete");
      } else if (modelResponseStatus === "empty") {
        analysisStatus = "incomplete";
        discarded.push("Model returned no findings for non-zero exit command");
      } else {
        analysisStatus = "partial";
        discarded.push("All model findings were rejected by schema validation");
      }

      if (detectorHint === "tsc_error") {
        log.info("compress-command-output: using tsc coverage guard for non-zero exit", {
          reason: modelFailed ? "model_failure" : modelResponseStatus === "empty" ? "empty_response" : "all_rejected",
        });
        const fb = compressCommandOutputFallback(command, output, exitCode, output.length);
        const fbDerived = deriveFromFindings(fb.findings, command, exitCode, detectorHint, output.length, output.length);

        fb.findings.forEach(f => { f.evidence = sanitizeEvidence(f.evidence); });
        fallbackUsed = true;

        const fbOutputData: CompressCommandOutputOutput = {
          summary: fbDerived.summary,
          analysis_status: fb.findings.length > 0 ? "partial" : "incomplete",
          first_failure: stripInternalFields(fbDerived.first_failure),
          primary_actionable_failure: stripInternalFields(fbDerived.primary_actionable_failure),
          findings: stripInternalFieldsFromArray(fb.findings),
          repeated_errors: fbDerived.repeated_errors,
          suggested_source_checks: fbDerived.suggested_source_checks,
          suggested_next_commands: fbDerived.suggested_next_commands,
          discarded_or_low_confidence: [...fbDerived.discarded_or_low_confidence, ...discarded],
          is_authoritative: false,
          _meta: {
            provider,
            model: modelName,
            input_truncated: inputTruncated,
            fallback_used: true,
            chunking: { total_chunks: 1, analyzed_chunks: 1, omitted_chunks: 0, omitted: [], input_truncated: inputTruncated, chunking_strategy: "model-first-fallback" },
            analysis_status: fb.findings.length > 0 ? "partial" : "incomplete",
            model_attempted: true,
            model_skip_reason: undefined,
            model_failure_reason: modelFailureReason,
            model_response_status: modelResponseStatus,
            model_call_attempts: modelCallAttempts,
            model_findings_received: modelFindingsReceived,
            model_findings_rejected: modelFindingsRejected,
            findings_retained: fb.findings.length,
            verified_findings: fb.findings.length,
            partial_findings: 0,
            unverified_findings: 0,
            batches_sent: batchesSent,
            batches_succeeded: batchesSucceeded,
            batches_failed: batchesFailed,
            detector_hint: detectorHint,
            model_detected_kind: modelDetectedKind,
            kind_mismatch: modelDetectedKind ? modelDetectedKind !== detectorHint : false,
          } as CompressCommandOutputOutput["_meta"],
        };

        const fbValidation = validateOutput("aux_compress_command_output", fbOutputData);
        if (fbValidation.ok) {
          return { content: [{ type: "text", text: JSON.stringify(fbValidation.data) }], isError: false };
        }
      }

      // Unknown format, no fallback — return incomplete
      discarded.push("Command exited with non-zero code but model analysis failed and no fallback available");
    } else if (modelFindings.length === 0) {
      // Truly nothing found (not empty/all-rejected coverage case)
      analysisStatus = "incomplete";
      discarded.push("Command exited with non-zero code but analysis found no issues");
    } else {
      // Model found things but none verified — partial
      analysisStatus = "partial";
      discarded.push("Command exited with non-zero code, findings present but evidence could not be fully verified");
    }
  }

  // ── Derive analysis_status from response quality ─────────
  if (analysisStatus === "complete") {
    if (modelResponseStatus === "partial_valid" || modelFindingsRejected > 0) {
      analysisStatus = "partial";
    }
  }

  // Derive from model findings
  const derived = deriveFromFindings(dedupedFindings, command, exitCode, detectorHint, output.length, output.length);

  // Use model summary if available, otherwise derived
  const summary = modelSummary ?? derived.summary;

  // Check for kind mismatch
  const kindMismatch = modelDetectedKind ? modelDetectedKind !== detectorHint : false;

  const outputData: CompressCommandOutputOutput = {
    summary,
    analysis_status: analysisStatus,
    first_failure: stripInternalFields(derived.first_failure),
    primary_actionable_failure: stripInternalFields(derived.primary_actionable_failure),
    findings: stripInternalFieldsFromArray(dedupedFindings),
    repeated_errors: derived.repeated_errors,
    suggested_source_checks: derived.suggested_source_checks,
    suggested_next_commands: derived.suggested_next_commands,
    discarded_or_low_confidence: [...derived.discarded_or_low_confidence, ...discarded],
    uncertainties: uncertainties.length > 0 ? uncertainties : undefined,
    reported_totals: reportedTotals,
    is_authoritative: false,
    _meta: {
      provider,
      model: modelName,
      input_truncated: inputTruncated,
      fallback_used: fallbackUsed,
      chunking: { total_chunks: 1, analyzed_chunks: 1, omitted_chunks: 0, omitted: [], input_truncated: inputTruncated, chunking_strategy: "model-first" },
      analysis_status: analysisStatus,
      model_attempted: true,
      model_skip_reason: undefined,
      model_failure_reason: modelFailureReason,
      // P0: unified reliability semantics — new fields
      model_response_status: modelResponseStatus,
      model_call_attempts: modelCallAttempts,
      model_findings_received: modelFindingsReceived,
      model_findings_rejected: modelFindingsRejected,
      // Canonical counts
      findings_retained: dedupedFindings.length,
      verified_findings: verifiedCount,
      partial_findings: partialCount,
      unverified_findings: unverifiedCount,
      batches_sent: batchesSent,
      batches_succeeded: batchesSucceeded,
      batches_failed: batchesFailed,
      detector_hint: detectorHint,
      model_detected_kind: modelDetectedKind,
      kind_mismatch: kindMismatch,
    } as CompressCommandOutputOutput["_meta"],
  };

  const outValidation = validateOutput("aux_compress_command_output", outputData);
  if (!outValidation.ok) {
    log.warn("compress-command-output: model-first output validation failed, using fallback", {
      error: outValidation.error,
    });
    return fallbackOnlyResult(provider, output, inputTruncated, command, exitCode, detectorHint);
  }

  return { content: [{ type: "text", text: JSON.stringify(outValidation.data) }], isError: false };
}

// ── Auto path (existing parser + batch hybrid) ─────────────

async function autoPath(
  client: ChatClient,
  provider: string,
  modelName: string,
  output: string,

  command: string | undefined,
  exitCode: number | undefined,
  focus: string | undefined,
  detectorHint: string,
  inputTruncated: boolean,
  maxChars: number,
  log: ReturnType<typeof traceLogger>,
): Promise<CallToolResult> {
  // Step 1: always run fallback → canonical findings
  const fb = compressCommandOutputFallback(command, output, exitCode, maxChars);
  let canonicalFindings = [...fb.findings];
  const parsedCount = fb.findings.length;
  let modelUsed = false;
  let modelCallMeta: ModelCallMeta = {
    candidate_batches: 0, batches_sent: 0,
    batches_succeeded: 0, batches_failed: 0, batches_omitted_by_budget: 0,
  };

  const enrichmentMode = getEnrichmentMode(focus, detectorHint, canonicalFindings);
  if (enrichmentMode !== "off") {
    if (detectorHint === "tsc_error") {
      const result = await runTscBatchModelPath(client, output, command, exitCode, focus, maxChars, canonicalFindings, log);
      if (result) {
        canonicalFindings = result.findings;
        modelUsed = true;
        modelCallMeta = result.meta;
      }
    } else {
      const result = await runChunkModelPath(client, output, command, exitCode, focus, maxChars, log);
      if (result && result.findings.length > 0) {
        canonicalFindings = result.findings;
        modelUsed = true;
      }
    }
  }

  const outputFindings = stripInternalFieldsFromArray(canonicalFindings);
  const derived = deriveFromFindings(canonicalFindings, command, exitCode, detectorHint, output.length, maxChars);

  const { meta } = chunkCommandOutput(output, maxChars);

  // Non-zero exit + empty findings → incomplete
  let analysisStatus: CompressCommandOutputOutput["analysis_status"] = "complete";
  if (exitCode !== undefined && exitCode !== 0 && canonicalFindings.length === 0) {
    analysisStatus = "incomplete";
  }

  const outputData: CompressCommandOutputOutput = {
    summary: derived.summary,
    analysis_status: analysisStatus,
    first_failure: stripInternalFields(derived.first_failure),
    primary_actionable_failure: stripInternalFields(derived.primary_actionable_failure),
    findings: outputFindings,
    repeated_errors: derived.repeated_errors,
    suggested_source_checks: derived.suggested_source_checks,
    suggested_next_commands: derived.suggested_next_commands,
    discarded_or_low_confidence: derived.discarded_or_low_confidence,
    is_authoritative: false,
    _meta: {
      provider,
      model: modelUsed ? modelName : "heuristic",
      tokens_used: 0,
      input_truncated: meta.input_truncated,
      fallback_used: !modelUsed,
      chunking: meta,
      analysis_status: analysisStatus,
      model_attempted: modelUsed,
      model_skip_reason: !modelUsed && enrichmentMode === "off" ? "deterministic_fast_path" : undefined,
      diagnostics_parsed: parsedCount,
      findings_retained: canonicalFindings.length,
      detector_hint: detectorHint,
      ...modelCallMeta,
    } as CompressCommandOutputOutput["_meta"],
  };

  return { content: [{ type: "text", text: JSON.stringify(outputData) }], isError: false };
}

// ── Fallback-only result ───────────────────────────────────

function fallbackOnlyResult(
  provider: string,
  output: string,
  inputTruncated: boolean,
  command: string | undefined,
  exitCode: number | undefined,
  detectorHint: string,
): CallToolResult {
  const fb = compressCommandOutputFallback(command, output, exitCode, output.length);
  const derived = deriveFromFindings(fb.findings, command, exitCode, detectorHint, output.length, output.length);

  let analysisStatus: CompressCommandOutputOutput["analysis_status"] = "complete";
  if (exitCode !== undefined && exitCode !== 0 && fb.findings.length === 0) {
    analysisStatus = "incomplete";
  }

  const outputData: CompressCommandOutputOutput = {
    summary: derived.summary,
    analysis_status: analysisStatus,
    first_failure: stripInternalFields(derived.first_failure),
    primary_actionable_failure: stripInternalFields(derived.primary_actionable_failure),
    findings: stripInternalFieldsFromArray(fb.findings),
    repeated_errors: derived.repeated_errors,
    suggested_source_checks: derived.suggested_source_checks,
    suggested_next_commands: derived.suggested_next_commands,
    discarded_or_low_confidence: derived.discarded_or_low_confidence,
    is_authoritative: false,
    _meta: {
      provider,
      model: "heuristic",
      input_truncated: inputTruncated,
      fallback_used: true,
      chunking: { total_chunks: 1, analyzed_chunks: 1, omitted_chunks: 0, omitted: [], input_truncated: inputTruncated, chunking_strategy: "fallback" },
      analysis_status: analysisStatus,
      model_attempted: false,
      model_skip_reason: "model_not_configured",
      findings_retained: fb.findings.length,
      detector_hint: detectorHint,
    } as CompressCommandOutputOutput["_meta"],
  };

  return { content: [{ type: "text", text: JSON.stringify(outputData) }], isError: false };
}

// ── Model path: TSC batch diagnostics (auto path only) ────

interface ModelCallMeta {
  candidate_batches: number;
  batches_sent: number;
  batches_succeeded: number;
  batches_failed: number;
  batches_omitted_by_budget: number;
  model_findings_received?: number;
  model_enhancements_applied?: number;
  unknown_diagnostic_ids?: number;
}

interface ChunkModelResult {
  findings: CommandOutputFinding[];
}

async function runTscBatchModelPath(
  client: ChatClient,
  output: string,
  command: string | undefined,
  exitCode: number | undefined,
  focus: string | undefined,
  maxChars: number,
  canonicalFindings: CommandOutputFinding[],
  log: ReturnType<typeof traceLogger>,
): Promise<{ findings: CommandOutputFinding[]; meta: ModelCallMeta } | null> {
  const { chunks } = chunkCommandOutput(output, maxChars);
  const systemPrompt = buildCompressCommandOutputSystemPrompt();

  const diagChunks = chunks.filter(c => c.label.startsWith("tsc diagnostics batch"));
  const cappedBatches = diagChunks.slice(0, MAX_MODEL_CALLS);

  if (cappedBatches.length === 0) return null;

  const findingById = new Map<string, CommandOutputFinding>();
  for (const f of canonicalFindings) {
    if (f._diagnostic_id) findingById.set(f._diagnostic_id, f);
  }

  let succeeded = 0;
  let failed = 0;
  let modelFindingsReceived = 0;
  let enhancementsApplied = 0;
  let unknownIds = 0;
  const seenOverlayIds = new Set<string>();

  for (const batch of cappedBatches) {
    try {
      const diagnostics = JSON.parse(batch.text);
      const userMsg = buildCompressCommandOutputBatchUserMessage(diagnostics, command, exitCode, focus);
      const raw = await client.chat(systemPrompt, userMsg);
      const jsonStr = extractJsonFromResponse(raw);
      const parsed = JSON.parse(jsonStr);

      const validated = ModelCommandOutputResponseSchema.safeParse(parsed);
      if (validated.success && validated.data.findings.length > 0) {
        for (const mf of validated.data.findings) {
          modelFindingsReceived++;
          if (!mf.diagnostic_id) continue;

          const target = findingById.get(mf.diagnostic_id);
          if (target) {
            if (!seenOverlayIds.has(mf.diagnostic_id)) {
              seenOverlayIds.add(mf.diagnostic_id);
              enhancementsApplied++;
            }
            if (mf.kind) target.kind = mf.kind;
            if (mf.message) target.message = mf.message;
            if (mf.confidence) target.confidence = mf.confidence;
            (target as unknown as Record<string, unknown>)._actionability = mf.actionability;
            (target as unknown as Record<string, unknown>)._model_enhanced = true;
          } else {
            unknownIds++;
          }
        }
      }
      succeeded++;
    } catch (err) {
      failed++;
    }
  }

  return {
    findings: canonicalFindings,
    meta: {
      candidate_batches: diagChunks.length,
      batches_sent: cappedBatches.length,
      batches_succeeded: succeeded,
      batches_failed: failed,
      batches_omitted_by_budget: Math.max(0, diagChunks.length - MAX_MODEL_CALLS),
      model_findings_received: modelFindingsReceived,
      model_enhancements_applied: enhancementsApplied,
      unknown_diagnostic_ids: unknownIds,
    },
  };
}

// ── Model path: generic chunk-based (auto path, non-tsc) ──

async function runChunkModelPath(
  client: ChatClient,
  output: string,
  command: string | undefined,
  exitCode: number | undefined,
  focus: string | undefined,
  maxChars: number,
  log: ReturnType<typeof traceLogger>,
): Promise<ChunkModelResult | null> {
  const systemPrompt = buildCompressCommandOutputSystemPrompt();
  const { chunks } = chunkCommandOutput(output, maxChars);
  const cappedChunks = chunks.slice(0, 20);
  if (cappedChunks.length === 0) return null;

  let succeeded = 0;
  const collected: CommandOutputFinding[] = [];
  const CONCURRENCY = 2;

  for (let i = 0; i < cappedChunks.length; i += CONCURRENCY) {
    const slice = cappedChunks.slice(i, i + CONCURRENCY);
    const promises = slice.map(async (chunk) => {
      try {
        const userMsg = buildCompressCommandOutputUserMessage(chunk.text, command, exitCode, focus);
        const raw = await client.chat(systemPrompt, userMsg);
        const jsonStr = extractJsonFromResponse(raw);
        const parsed = JSON.parse(jsonStr);

        if (parsed?.findings && Array.isArray(parsed.findings)) {
          for (const f of parsed.findings) {
            if (f.kind && f.kind !== "info") collected.push(f as CommandOutputFinding);
          }
        } else if (parsed && typeof parsed === "object" && parsed.kind && parsed.kind !== "info") {
          collected.push(parsed as CommandOutputFinding);
        }
        succeeded++;
      } catch (err) {
        log.warn("compress-command-output: chunk failed", {
          chunk: chunk.label,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    await Promise.allSettled(promises);
  }

  if (collected.length === 0) return null;
  return { findings: deduplicateCommandFindings(collected) };
}

// ── Derived fields computation ────────────────────────────

interface DerivedFields {
  summary: string;
  first_failure: CommandOutputFinding | undefined;
  primary_actionable_failure: CommandOutputFinding | undefined;
  repeated_errors: CompressCommandOutputOutput["repeated_errors"];
  suggested_source_checks: string[];
  suggested_next_commands: string[];
  discarded_or_low_confidence: string[];
}

function classifySourceKindFromFile(filePath: string | undefined): string {
  if (!filePath) return "unknown";
  const normalized = filePath.replace(/\\/g, "/");
  if (/\/node_modules\//.test(normalized)) return "dependency";
  if (/(?:\.next\/|dist\/|build\/|__generated__\/)/.test(normalized)) return "generated";
  if (/\.(test|spec)\.\w+$/i.test(normalized)) return "test";
  if (/(?:^|\/)(src|lib|app|pages|components|utils|hooks|services)\//.test(normalized)) return "project";
  return "unknown";
}

function deriveFromFindings(
  findings: CommandOutputFinding[],
  command: string | undefined,
  exitCode: number | undefined,
  outputKind: string,
  outputLength: number,
  maxChars: number,
): DerivedFields {
  const sortedByIndex = [...findings].sort(
    (a, b) => (a.first_seen_index ?? 0) - (b.first_seen_index ?? 0),
  );
  const firstFailure = sortedByIndex.find(f =>
    f.kind !== "warning" && f.kind !== "info",
  );

  const sourceKindPriority: Record<string, number> = {
    project: 0, test: 1, generated: 2, dependency: 3, unknown: 4,
  };
  const primaryActionable = [...findings]
    .filter(f => f.kind !== "warning" && f.kind !== "info")
    .sort((a, b) => {
      const skA = sourceKindPriority[classifySourceKindFromFile(a.file)] ?? 99;
      const skB = sourceKindPriority[classifySourceKindFromFile(b.file)] ?? 99;
      if (skA !== skB) return skA - skB;
      return (a.first_seen_index ?? 0) - (b.first_seen_index ?? 0);
    })[0];

  const patternMap = new Map<string, { count: number; examples: string[] }>();
  for (const f of findings) {
    const normKey = `${f.error_code ?? ""}:${f.message.toLowerCase().trim()}`;
    const entry = patternMap.get(normKey);
    if (entry) {
      entry.count++;
      if (entry.examples.length < 3) {
        entry.examples.push(`${f.file ?? "?"}:${f.line ?? "?"} — ${f.evidence.slice(0, 120)}`);
      }
    } else {
      patternMap.set(normKey, {
        count: 1,
        examples: [`${f.file ?? "?"}:${f.line ?? "?"} — ${f.evidence.slice(0, 120)}`],
      });
    }
  }
  const repeated_errors: DerivedFields["repeated_errors"] = [];
  for (const [, info] of patternMap) {
    if (info.count > 1) {
      repeated_errors.push({
        message: info.examples[0]!.slice(0, 200),
        count: info.count,
        examples: info.examples,
      });
    }
  }
  repeated_errors.sort((a, b) => b.count - a.count);

  const seenFiles = new Set<string>();
  const suggested_source_checks: string[] = [];
  const sortedForChecks = [...findings].sort((a, b) => {
    const skA = sourceKindPriority[classifySourceKindFromFile(a.file)] ?? 99;
    const skB = sourceKindPriority[classifySourceKindFromFile(b.file)] ?? 99;
    return skA - skB;
  });
  for (const f of sortedForChecks) {
    if (suggested_source_checks.length >= 5) break;
    if (f.file && !seenFiles.has(f.file)) {
      seenFiles.add(f.file);
      suggested_source_checks.push(`Check ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`);
    }
  }

  const suggested_next_commands: string[] = [];
  if (outputKind === "tsc_error") suggested_next_commands.push("npx tsc --noEmit");
  if (outputKind === "test_output") suggested_next_commands.push("Run the specific failing test file with verbose output");
  if (outputKind === "eslint_output") suggested_next_commands.push("npx eslint <files>");

  const discarded: string[] = [];
  if (outputLength > maxChars) {
    discarded.push(`Output truncated from ${outputLength} to ${maxChars} chars`);
  }

  const errorCount = findings.filter(f => f.kind !== "warning" && f.kind !== "info").length;
  const commandLabel = command ? `Command \`${command}\` ` : "";
  const exitLabel = exitCode !== undefined ? ` (exit code: ${exitCode})` : "";
  const summary =
    `${commandLabel}${exitLabel}: Detected "${outputKind}". ` +
    `Parsed ${findings.length} diagnostics, retained ${findings.length} findings. ` +
    `${errorCount} error(s). ` +
    (repeated_errors.length > 0 ? `${repeated_errors.length} repeated error pattern(s). ` : "") +
    (firstFailure ? `First failure: ${firstFailure.file}:${firstFailure.line} ${firstFailure.error_code ?? ""}. ` : "") +
    (primaryActionable ? `Primary actionable: ${primaryActionable.file}:${primaryActionable.line}.` : "");

  return {
    summary, first_failure: firstFailure, primary_actionable_failure: primaryActionable,
    repeated_errors, suggested_source_checks, suggested_next_commands,
    discarded_or_low_confidence: discarded,
  };
}
