import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { hasModelConfig, loadConfig, loadConfigFallback } from "../config.js";
import { ChatClient } from "../chat-client.js";
import {
  validateInput,
  ModelCommandOutputResponseSchema,
  type CompressCommandOutputInput,
  type CompressCommandOutputOutput,
} from "../schema.js";
import {
  buildCompressCommandOutputSystemPrompt,
  buildCompressCommandOutputBatchUserMessage,
  buildCompressCommandOutputUserMessage,
  extractJsonFromResponse,
} from "../prompts.js";
import {
  compressCommandOutputFallback,
  type CommandOutputFinding,
} from "../fallback/compress-command-output.js";
import { chunkCommandOutput, detectOutputKind } from "../chunking/command-output.js";
import { deduplicateCommandFindings } from "../chunking/merge.js";
import { createTraceId, traceLogger, logDuration } from "../logger.js";

type ConfigLike = ReturnType<typeof loadConfig> | ReturnType<typeof loadConfigFallback>;

function hasApiKey(config: ConfigLike): config is AppConfig {
  return "modelApiKey" in config && typeof (config as AppConfig).modelApiKey === "string" && (config as AppConfig).modelApiKey.length > 0;
}

// ── Batching config ───────────────────────────────────────

const BATCH_MAX_DIAGNOSTICS = 20;
const BATCH_MAX_CHARS = 6000;
const MAX_MODEL_CALLS = 5;

// ── Enrichment decision ───────────────────────────────────

type EnrichmentMode = "off" | "on";

/**
 * Decide whether to call model for semantic enrichment.
 *
 * "off" (skip model):
 *   - focus is "errors only" / "structure" → structure-only request
 *   - all findings have _diagnostic_id (high confidence parser)
 *
 * "on" (call model):
 *   - focus has "root cause", "priority", "impact", "fix", "explain"
 *   - unknown output kind
 */
function getEnrichmentMode(
  focus: string | undefined,
  outputKind: string,
  findings: CommandOutputFinding[],
): EnrichmentMode {
  // Explicit structure-only request → skip model
  if (focus && /\b(errors?\s*only|structure(d)?\s*only|list\s*only)\b/i.test(focus)) {
    return "off";
  }

  // Explicit enrichment request → call model
  if (focus && /\b(root\s*cause|priority|impact|fix|explain|enrich|semantic)\b/i.test(focus)) {
    return "on";
  }

  // For well-structured output with high-confidence parser → skip
  if (outputKind === "tsc_error" && findings.length > 0 && findings.every(f => f._diagnostic_id)) {
    return "off";
  }

  // Unknown/generic output → benefit from model
  if (outputKind === "generic_log") {
    return "on";
  }

  return "off";
}

export async function handleCompressCommandOutput(
  input: unknown,
  config: ConfigLike,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const tid = createTraceId();
  const log = traceLogger(tid);

  const validation = validateInput("aux_compress_command_output", input);
  if (!validation.ok) throw new McpError(ErrorCode.InvalidParams, validation.error);

  const validated = validation.data as CompressCommandOutputInput;
  const { command, output, exit_code, focus, max_chars = 120_000 } = validated;

  log.info("compress_command_output start", { command, outputLen: output.length, exit_code });

  try { return await handleImpl(); }
  finally { logDuration(tid, "compress_command_output done", t0); }

  async function handleImpl(): Promise<CallToolResult> {
    const provider = (config as AppConfig).modelProvider ?? process.env.AUX_MODEL_PROVIDER ?? "remote";
    const modelAvailable = hasModelConfig() && hasApiKey(config);
    const outputKind = detectOutputKind(output);

    // Step 1: Always run deterministic fallback → canonical findings
    const fb = compressCommandOutputFallback(command, output, exit_code, max_chars);
    let canonicalFindings = [...fb.findings];

    // Diagnostic count from parser
    const parsedCount = fb.findings.length;
    let modelUsed = false;
    let modelCallMeta: ModelCallMeta = {
      candidate_batches: 0, batches_sent: 0,
      batches_succeeded: 0, batches_failed: 0, batches_omitted_by_budget: 0,
    };

    // Step 2: Optionally enhance with model (overlay, not replace)
    // P0-2: enrichment decision — skip model for structure-only requests
    const enrichmentMode = getEnrichmentMode(focus, outputKind, canonicalFindings);

    if (modelAvailable && enrichmentMode !== "off") {
      const client = new ChatClient(config as AppConfig);
      if (client.isAvailable()) {
        if (outputKind === "tsc_error") {
          const result = await runTscBatchModelPath(client, output, command, exit_code, focus, max_chars, canonicalFindings, log);
          if (result) {
            canonicalFindings = result.findings;
            modelUsed = true;
            modelCallMeta = result.meta;
          }
        } else {
          const result = await runChunkModelPath(client, output, command, exit_code, focus, max_chars, log);
          if (result && result.findings.length > 0) {
            canonicalFindings = result.findings;
            modelUsed = true;
          }
        }
      } else {
        log.info("compress-command-output: ChatClient unavailable, using fallback");
      }
    }

    // Step 3: Strip internal fields before output
    const outputFindings = canonicalFindings.map(({ _diagnostic_id, ...rest }) => rest);

    // Step 4: Re-derive all fields from canonical findings
    const derived = deriveFromFindings(canonicalFindings, command, exit_code, outputKind, output.length, max_chars);

    // Step 5: Build output
    const { meta } = chunkCommandOutput(output, max_chars);

    const outputData: CompressCommandOutputOutput = {
      summary: derived.summary,
      first_failure: derived.first_failure,
      primary_actionable_failure: derived.primary_actionable_failure,
      findings: outputFindings,
      repeated_errors: derived.repeated_errors,
      suggested_source_checks: derived.suggested_source_checks,
      suggested_next_commands: derived.suggested_next_commands,
      discarded_or_low_confidence: derived.discarded_or_low_confidence,
      is_authoritative: false,
      _meta: {
        provider,
        model: modelUsed ? (config as AppConfig).modelName : "heuristic",
        tokens_used: 0,
        input_truncated: meta.input_truncated,
        fallback_used: !modelUsed,
        chunking: meta,
        diagnostics_parsed: parsedCount,
        findings_retained: canonicalFindings.length,
        ...modelCallMeta,
      } as CompressCommandOutputOutput["_meta"],
    };

    return { content: [{ type: "text", text: JSON.stringify(outputData) }], isError: false };
  }
}

// ── Model path: TSC batch diagnostics ─────────────────────

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

  // Filter to diagnostic batch chunks
  const diagChunks = chunks.filter(c => c.label.startsWith("tsc diagnostics batch"));
  const cappedBatches = diagChunks.slice(0, MAX_MODEL_CALLS);

  if (cappedBatches.length === 0) return null;

  log.info("compress-command-output: batch model path", {
    totalChunks: chunks.length,
    diagBatches: diagChunks.length,
    sent: cappedBatches.length,
  });

  // Build Map for exact diagnostic_id lookup
  const findingById = new Map<string, CommandOutputFinding>();
  for (const f of canonicalFindings) {
    if (f._diagnostic_id) findingById.set(f._diagnostic_id, f);
  }

  let succeeded = 0;
  let failed = 0;
  let modelFindingsReceived = 0;
  let enhancementsApplied = 0;
  let unknownIds = 0;
  const seenOverlayIds = new Set<string>(); // track duplicate model responses

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
            // P0-2: Overlay — only enhance allowed fields
            if (!seenOverlayIds.has(mf.diagnostic_id)) {
              seenOverlayIds.add(mf.diagnostic_id);
              enhancementsApplied++;
            }
            // Apply enhancement fields only
            if (mf.kind) target.kind = mf.kind;
            if (mf.message) target.message = mf.message;
            if (mf.confidence) target.confidence = mf.confidence;
            // actionability is internal — carry through for sorting
            (target as unknown as Record<string, unknown>)._actionability = mf.actionability;
            (target as unknown as Record<string, unknown>)._model_enhanced = true;
          } else {
            unknownIds++;
            log.warn("compress-command-output: unknown diagnostic_id from model", {
              diagnostic_id: mf.diagnostic_id,
            });
          }
        }
      }
      succeeded++;
    } catch (err) {
      log.warn("compress-command-output: batch failed", {
        batch: batch.label,
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }

  // Canonical findings ALWAYS preserved — model only overlays enhancements
  // P0-2: If all batches fail, canonical findings are still complete
  // P0-3: No semantic dedup on canonical findings

  log.info("compress-command-output: batch model path done", {
    succeeded, failed,
    modelFindingsReceived, enhancementsApplied, unknownIds,
    canonical: canonicalFindings.length,
  });

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

// ── Model path: generic chunk-based (for non-tsc outputs) ─

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

  // Process chunks with limited concurrency
  const CONCURRENCY = 2;
  for (let i = 0; i < cappedChunks.length; i += CONCURRENCY) {
    const slice = cappedChunks.slice(i, i + CONCURRENCY);
    const promises = slice.map(async (chunk) => {
      try {
        const userMsg = buildCompressCommandOutputUserMessage(chunk.text, command, exitCode, focus);
        const raw = await client.chat(systemPrompt, userMsg);
        const jsonStr = extractJsonFromResponse(raw);
        const parsed = JSON.parse(jsonStr);

        // Handle both new array format and legacy single-object format
        if (parsed && parsed.findings && Array.isArray(parsed.findings)) {
          for (const f of parsed.findings) {
            if (f.kind && f.kind !== "info") {
              collected.push(f as CommandOutputFinding);
            }
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

  if (collected.length === 0) {
    if (succeeded === 0) {
      log.warn("compress-command-output: all chunks failed, using fallback entirely");
    }
    return null;
  }

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

/**
 * Quick source kind classification from file path (no dependency on diagnostics module).
 */
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
  // first_failure: first error by first_seen_index (original order)
  const sortedByIndex = [...findings].sort(
    (a, b) => (a.first_seen_index ?? 0) - (b.first_seen_index ?? 0),
  );
  const firstFailure = sortedByIndex.find(f =>
    f.kind !== "warning" && f.kind !== "info",
  );

  // primary_actionable_failure: most actionable project error
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

  // repeated_errors: group by error_code + normalized message (not file/line)
  // P0-3: semantic grouping only for repeated_errors, NOT deleting canonical findings
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
      const firstExample = info.examples[0] ?? "";
      repeated_errors.push({
        message: firstExample.slice(0, 200),
        count: info.count,
        examples: info.examples,
      });
    }
  }
  repeated_errors.sort((a, b) => b.count - a.count);

  // suggested_source_checks: top 5 by source kind (project before generated)
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

  // suggested_next_commands
  const suggested_next_commands: string[] = [];
  if (outputKind === "tsc_error") suggested_next_commands.push("npx tsc --noEmit");
  if (outputKind === "test_output") suggested_next_commands.push("Run the specific failing test file with verbose output");
  if (outputKind === "eslint_output") suggested_next_commands.push("npx eslint <files>");

  // discarded_or_low_confidence
  const discarded: string[] = [];
  if (outputLength > maxChars) {
    discarded.push(`Output truncated from ${outputLength} to ${maxChars} chars`);
  }

  // summary: distinguish diagnostics parsed, findings retained, repeated patterns
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
    summary,
    first_failure: firstFailure,
    primary_actionable_failure: primaryActionable,
    repeated_errors,
    suggested_source_checks,
    suggested_next_commands,
    discarded_or_low_confidence: discarded,
  };
}
