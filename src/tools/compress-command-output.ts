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

const BATCH_MAX_DIAGNOSTICS = 8;
const BATCH_MAX_CHARS = 6000;
const MAX_MODEL_CALLS = 5;

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

    // Step 1: Always run deterministic fallback for findings
    const fb = compressCommandOutputFallback(command, output, exit_code, max_chars);
    let finalFindings = [...fb.findings];
    let modelUsed = false;
    let modelCallMeta: ModelCallMeta | null = null;

    // Step 2: Optionally enhance with model
    if (modelAvailable) {
      const client = new ChatClient(config as AppConfig);
      if (client.isAvailable()) {
        if (outputKind === "tsc_error") {
          // For tsc: use batch diagnostic approach
          const result = await runTscBatchModelPath(client, output, command, exit_code, focus, max_chars, fb.findings, log);
          if (result) {
            finalFindings = result.findings;
            modelUsed = true;
            modelCallMeta = result.meta;
          }
        } else {
          // For other formats: use chunk-based approach
          const result = await runChunkModelPath(client, output, command, exit_code, focus, max_chars, log);
          if (result && result.findings.length > 0) {
            finalFindings = result.findings;
            modelUsed = true;
            modelCallMeta = { batches_sent: 0, batches_succeeded: 0, batches_failed: 0, candidate_batches: 0, batches_omitted_by_budget: 0 };
          }
        }
      } else {
        log.info("compress-command-output: ChatClient unavailable, using fallback");
      }
    }

    // Step 3: Re-derive all fields from final findings
    const derived = deriveFromFindings(finalFindings, command, exit_code, outputKind, output.length, max_chars);

    // Step 4: Build output
    const { meta } = chunkCommandOutput(output, max_chars);

    const outputData: CompressCommandOutputOutput = {
      summary: derived.summary,
      first_failure: derived.first_failure,
      findings: finalFindings,
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
        ...(modelCallMeta ?? {}),
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
  fallbackFindings: CommandOutputFinding[],
  log: ReturnType<typeof traceLogger>,
): Promise<{ findings: CommandOutputFinding[]; meta: ModelCallMeta } | null> {
  const { chunks, meta } = chunkCommandOutput(output, maxChars);
  const systemPrompt = buildCompressCommandOutputSystemPrompt();

  // Filter to diagnostic batch chunks (they contain JSON arrays)
  const diagChunks = chunks.filter(c => c.label.startsWith("tsc diagnostics batch"));
  const cappedBatches = diagChunks.slice(0, MAX_MODEL_CALLS);

  if (cappedBatches.length === 0) return null;

  log.info("compress-command-output: batch model path", {
    totalChunks: chunks.length,
    diagBatches: diagChunks.length,
    sent: cappedBatches.length,
  });

  let succeeded = 0;
  let failed = 0;
  const collected: CommandOutputFinding[] = [];

  for (const batch of cappedBatches) {
    try {
      // Parse the JSON array of diagnostics from the chunk text
      const diagnostics = JSON.parse(batch.text);
      const userMsg = buildCompressCommandOutputBatchUserMessage(diagnostics, command, exitCode, focus);
      const raw = await client.chat(systemPrompt, userMsg);
      const jsonStr = extractJsonFromResponse(raw);
      const parsed = JSON.parse(jsonStr);

      // Validate with model response schema
      const validated = ModelCommandOutputResponseSchema.safeParse(parsed);
      if (validated.success && validated.data.findings.length > 0) {
        // Merge model findings with corresponding fallback findings
        for (const mf of validated.data.findings) {
          const diagId = mf.diagnostic_id;
          const fbFinding = diagId
            ? fallbackFindings.find(f => {
                // Match by diagnostic id (reconstructed: kind:file:Lline:errorCode:seq)
                const parts = diagId.split(":");
                const file = parts[1];
                const errorCode = parts[3];
                return f.file === file && f.error_code === errorCode;
              })
            : undefined;

          if (fbFinding) {
            // Enhance fallback finding with model classification
            collected.push({
              ...fbFinding,
              kind: mf.kind ?? fbFinding.kind,
              message: mf.message ?? fbFinding.message,
              confidence: mf.confidence ?? fbFinding.confidence,
            });
          } else {
            // Model finding without a corresponding diagnostic — add as low confidence
            collected.push({
              kind: mf.kind ?? "unknown",
              message: mf.message ?? "Model-identified finding",
              evidence: "",
              confidence: "low",
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

  // If all batches failed or no findings collected, return null (use fallback)
  if (collected.length === 0) {
    if (succeeded === 0) {
      log.warn("compress-command-output: all batches failed, using fallback entirely");
    }
    return null;
  }

  // Deduplicate merged findings
  const deduped = deduplicateCommandFindings(collected);

  log.info("compress-command-output: batch model path done", {
    succeeded, failed, collected: collected.length, deduped: deduped.length,
  });

  return {
    findings: deduped,
    meta: {
      candidate_batches: diagChunks.length,
      batches_sent: cappedBatches.length,
      batches_succeeded: succeeded,
      batches_failed: failed,
      batches_omitted_by_budget: Math.max(0, diagChunks.length - MAX_MODEL_CALLS),
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
  repeated_errors: CompressCommandOutputOutput["repeated_errors"];
  suggested_source_checks: string[];
  suggested_next_commands: string[];
  discarded_or_low_confidence: string[];
}

function deriveFromFindings(
  findings: CommandOutputFinding[],
  command: string | undefined,
  exitCode: number | undefined,
  outputKind: string,
  outputLength: number,
  maxChars: number,
): DerivedFields {
  // first_failure: first error-type finding
  const firstFailure = findings.find(f =>
    f.kind !== "warning" && f.kind !== "info",
  );

  // repeated_errors: group by normalized message
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
  const repeated_errors: DerivedFields["repeated_errors"] = [];
  for (const [message, info] of counts) {
    if (info.count > 1) {
      repeated_errors.push({ message, count: info.count, examples: info.examples });
    }
  }
  repeated_errors.sort((a, b) => b.count - a.count);

  // suggested_source_checks: top 5 by usability (project before generated)
  const seenFiles = new Set<string>();
  const suggested_source_checks: string[] = [];
  for (const f of findings) {
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
  const discarded: string[] = ["Full output not semantically analyzed — pattern matching only"];
  if (outputLength > maxChars) {
    discarded.push(`Output truncated from ${outputLength} to ${maxChars} chars`);
  }

  // summary
  const errorCount = findings.filter(f => f.kind !== "warning" && f.kind !== "info").length;
  const warnCount = findings.filter(f => f.kind === "warning").length;
  const commandLabel = command ? `Command \`${command}\` ` : "";
  const exitLabel = exitCode !== undefined ? ` (exit code: ${exitCode})` : "";
  const summary =
    `${commandLabel}${exitLabel}: Detected "${outputKind}". ` +
    `${errorCount} error(s), ${warnCount} warning(s). ` +
    (firstFailure ? `First failure: ${firstFailure.message}. ` : "") +
    (repeated_errors.length > 0 ? `${repeated_errors.length} repeated error pattern(s).` : "");

  return {
    summary,
    first_failure: firstFailure,
    repeated_errors,
    suggested_source_checks,
    suggested_next_commands,
    discarded_or_low_confidence: discarded,
  };
}
