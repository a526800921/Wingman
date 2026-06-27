import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { hasModelConfig, loadConfig, loadConfigFallback } from "../config.js";
import { ChatClient } from "../chat-client.js";
import {
  validateInput,
  validateOutput,
  ModelDiffReviewResponseSchema,
  type ReviewDiffByFileInput,
  type ReviewDiffByFileOutput,
  type DiffFinding,
} from "../schema.js";
import type { InputChunk } from "../chunking/types.js";
import {
  buildReviewDiffByFileSystemPrompt,
  buildReviewDiffByFileUserMessage,
  extractJsonFromResponse,
} from "../prompts.js";
import { reviewDiffByFileFallback } from "../fallback/review-diff-by-file.js";
import { buildDiagnosticMeta } from "../model-runtime/diagnostics.js";
import { chunkDiff } from "../chunking/diff.js";
import type { ChunkMeta } from "../chunking/types.js";
import { sortFindings, deduplicateFindings, buildFindingIdentity } from "../chunking/merge.js";
import { createTraceId, traceLogger, logDuration } from "../logger.js";

type ConfigLike = ReturnType<typeof loadConfig> | ReturnType<typeof loadConfigFallback>;

function hasApiKey(config: ConfigLike): config is AppConfig {
  return "modelApiKey" in config && typeof (config as AppConfig).modelApiKey === "string" && (config as AppConfig).modelApiKey.length > 0;
}

/**
 * P2: Small diff → single model call. Sends entire diff and expects per-file findings.
 */
async function singleCallModelReview(
  client: ChatClient,
  diff: string,
  focus: string | undefined,
  log: ReturnType<typeof traceLogger>,
): Promise<{ findings: DiffFinding[] | null; tokens: number; promptTokens: number; completionTokens: number } | null> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = buildReviewDiffByFileSystemPrompt(today);
    const userMsg = buildReviewDiffByFileUserMessage(diff, "full-diff", false, focus, today);
    const { text: raw, usage } = await client.chat(systemPrompt, userMsg);
    const jsonStr = extractJsonFromResponse(raw);
    const parsed = JSON.parse(jsonStr);

    const findings: DiffFinding[] = [];
    if (parsed?.findings && Array.isArray(parsed.findings)) {
      for (const f of parsed.findings) {
        if (f.risk && f.risk !== "no_issues") {
          findings.push(findingsFromModel(f, String(f.file ?? "unknown")));
        }
      }
    }
    return { findings: findings.length > 0 ? findings : null, tokens: usage?.total_tokens ?? 0, promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0 };
  } catch (err) {
    log.warn("review-diff-by-file: single-call model review failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function findingsFromModel(
  parsed: Record<string, unknown>,
  chunkLabel: string,
): DiffFinding {
  return {
    risk: String(parsed.risk ?? ""),
    severity: (parsed.severity as DiffFinding["severity"]) ?? "low",
    file: String(parsed.file ?? chunkLabel),
    hunk: parsed.hunk ? String(parsed.hunk) : undefined,
    location: parsed.location ? String(parsed.location) : undefined,
    explanation: parsed.explanation ? String(parsed.explanation) : undefined,
    evidence: String(parsed.evidence ?? ""),
    introduced_by_diff: typeof parsed.introduced_by_diff === "boolean" ? parsed.introduced_by_diff : undefined,
    confidence: (parsed.confidence as DiffFinding["confidence"]) ?? "medium",
  };
}

/**
 * Aggregate model findings by file to produce FileReview[] structure.
 */
function aggregateByFile(
  findings: DiffFinding[],
  chunks: InputChunk[],
  meta: ChunkMeta,
): ReviewDiffByFileOutput["files"] {
  const fileMap = new Map<string, { findings: DiffFinding[]; chunks: InputChunk[] }>();

  for (const f of findings) {
    const key = f.file;
    if (!fileMap.has(key)) fileMap.set(key, { findings: [], chunks: [] });
    fileMap.get(key)!.findings.push(f);
  }

  for (const chunk of chunks) {
    const filePath = chunk.source ?? chunk.label;
    if (!fileMap.has(filePath)) fileMap.set(filePath, { findings: [], chunks: [] });
    fileMap.get(filePath)!.chunks.push(chunk);
  }

  for (const omitted of meta.omitted) {
    const filePath = omitted.source ?? omitted.label;
    if (!fileMap.has(filePath)) {
      fileMap.set(filePath, { findings: [], chunks: [] });
    }
  }

  const files: ReviewDiffByFileOutput["files"] = [];
  for (const [file, data] of fileMap) {
    const isOmitted = meta.omitted.some(o => (o.source ?? o.label) === file);
    const analysisStatus = isOmitted
      ? "omitted"
      : data.findings.length === 0
        ? "clean"
        : "analyzed";

    files.push({
      file,
      change_summary: `${file}: ${data.findings.length} finding(s), ${data.chunks.length} chunk(s), status=${analysisStatus}`,
      findings: data.findings,
      suggested_source_checks: data.findings.length > 0
        ? [`${file}: Review findings above`]
        : [],
      suggested_tests: [`Run existing tests for ${file}`],
      uncertainties: [],
    });
  }

  return files;
}

/**
 * Single helper to construct a ReviewDiffByFileOutput from a fallback result.
 * Eliminates duplicated assembly across the three fallback paths.
 */
function buildFallbackOutput(
  fb: ReturnType<typeof reviewDiffByFileFallback>,
  provider: string,
  meta: ChunkMeta,
): ReviewDiffByFileOutput {
  const fbFindings: DiffFinding[] = [];
  for (const fr of fb.files) {
    for (const f of fr.findings) {
      fbFindings.push({
        risk: f.risk,
        severity: f.severity,
        file: f.file,
        hunk: f.hunk,
        location: f.location,
        explanation: f.explanation,
        evidence: f.evidence,
        introduced_by_diff: f.introduced_by_diff,
        confidence: f.confidence ?? "medium",
      });
    }
  }
  const deduped = deduplicateFindings(fbFindings, buildFindingIdentity);
  const sorted = sortFindings(deduped);

  return {
    overall_summary: fb.overall_summary,
    files: fb.files,
    top_risks: sorted.slice(0, 10),
    omitted_files: fb.omitted_files,
    analysis_status: "partial" as const,
    is_authoritative: false,
    _meta: {
      provider,
      model: "heuristic",
      tokens_used: 0,
      input_truncated: meta.input_truncated,
      fallback_used: true,
      analysis_status: "partial" as const,
      chunking: meta,
      ...buildDiagnosticMeta({
        analysisMode: "heuristic_fallback",
        modelUsed: false,
        modelAttempted: false,
        modelSkipReason: "model_not_configured",
        limitations: ["Pattern-based review only, no semantic analysis"],
      }),
    },
  };
}

export async function handleReviewDiffByFile(
  input: unknown,
  config: ConfigLike,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const tid = createTraceId();
  const log = traceLogger(tid);

  const validation = validateInput("aux_review_diff_by_file", input);
  if (!validation.ok) throw new McpError(ErrorCode.InvalidParams, validation.error);

  const validated = validation.data as ReviewDiffByFileInput;
  const { diff: originalDiff, focus, max_chars_per_file = 40_000, max_files = 30 } = validated;

  log.info("review_diff_by_file start", { diffLen: originalDiff.length, max_chars_per_file, max_files });

  try { return await handleImpl(); }
  finally { logDuration(tid, "review_diff_by_file done", t0); }

  async function handleImpl(): Promise<CallToolResult> {
    const { chunks, meta } = chunkDiff(originalDiff, { max_chars_per_file, max_files });
    const provider = (config as AppConfig).modelProvider ?? process.env.AUX_MODEL_PROVIDER ?? "remote";
    const modelAvailable = hasModelConfig() && hasApiKey(config);
    let allFindings: DiffFinding[] = [];
    let totalTokens = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    if (modelAvailable && chunks.length > 0) {
      const client = new ChatClient(config as AppConfig);

      if (!client.isAvailable()) {
        log.info("review-diff-by-file: ChatClient unavailable, using fallback");
        return fallbackResult(provider, meta);
      }

      // P2: Small diff → single model call (entire diff, not per-file)
      const SINGLE_CALL_BUDGET = 15000;
      if (originalDiff.length <= SINGLE_CALL_BUDGET && chunks.length <= 5) {
        const result = await singleCallModelReview(client, originalDiff, focus, log);
        if (result) {
          allFindings = result.findings ?? [];
          totalTokens += result.tokens;
          totalPromptTokens += result.promptTokens;
          totalCompletionTokens += result.completionTokens;
          log.info("review-diff-by-file: single-call model path done", { findings: allFindings.length });
        }
      }

      // If single-call produced findings, skip per-chunk loop
      if (allFindings.length === 0) {
        let succeededChunks = 0;
        let failedChunks = 0;
        const CONCURRENCY = 2;
        const MAX_MODEL_CHUNKS = 20;

        const today = new Date().toISOString().slice(0, 10);
        const systemPrompt = buildReviewDiffByFileSystemPrompt(today);
        const cappedChunks = chunks.slice(0, MAX_MODEL_CHUNKS);

        for (let i = 0; i < cappedChunks.length; i += CONCURRENCY) {
        const slice = cappedChunks.slice(i, i + CONCURRENCY);
        const promises = slice.map(async (chunk) => {
          const chunkLabel = chunk.source ?? chunk.label;
          const userMsg = buildReviewDiffByFileUserMessage(
            chunk.text, chunkLabel, chunk.truncated, focus, today,
          );
          try {
            const { text: raw, usage } = await client.chat(systemPrompt, userMsg);
            const jsonStr = extractJsonFromResponse(raw);
            const parsed = JSON.parse(jsonStr);

            // Handle array format: {"findings": [...]}
            if (parsed && Array.isArray(parsed.findings)) {
              for (const f of parsed.findings) {
                if (f.risk && f.risk !== "no_issues") {
                  allFindings.push(findingsFromModel(f, chunkLabel));
                }
              }
            } else if (parsed && typeof parsed === "object" && parsed.risk && parsed.risk !== "no_issues") {
              // Legacy single-object format
              allFindings.push(findingsFromModel(parsed, chunkLabel));
            }
            totalTokens += usage?.total_tokens ?? 0;
            totalPromptTokens += usage?.prompt_tokens ?? 0;
            totalCompletionTokens += usage?.completion_tokens ?? 0;
            succeededChunks++;
          } catch (err) {
            failedChunks++;
            log.warn("review-diff-by-file: chunk model call failed", {
              chunk: chunkLabel,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
        await Promise.allSettled(promises);
      }

      // If every chunk failed, fall back entirely to heuristic
      if (succeededChunks === 0 && failedChunks > 0) {
        log.warn("review-diff-by-file: all chunks failed, falling back to heuristic", { failedChunks });
        return fallbackResult(provider, meta);
      }

      log.info("review-diff-by-file: model path done", { succeededChunks, failedChunks, findings: allFindings.length });
      } // end if (allFindings.length === 0)
    }

    if (!modelAvailable) {
      return fallbackResult(provider, meta);
    }

    // Model path succeeded — validate and return
    const deduped = deduplicateFindings(allFindings, buildFindingIdentity);
    const sorted = sortFindings(deduped);
    const files = aggregateByFile(sorted, chunks, meta);

    const output: ReviewDiffByFileOutput = {
      overall_summary: `Model review of ${chunks.length} chunk(s) across ${files.length} file(s). ${sorted.length} finding(s).`,
      files,
      top_risks: sorted.slice(0, 10),
      omitted_files: meta.omitted.map(o => ({ file: o.source ?? o.label, reason: o.reason })),
      is_authoritative: false,
      analysis_status: meta.input_truncated ? "partial" : "complete" as const,
      _meta: { provider, model: (config as AppConfig).modelName, tokens_used: totalTokens, prompt_tokens: totalPromptTokens || undefined, completion_tokens: totalCompletionTokens || undefined, input_truncated: meta.input_truncated, fallback_used: false, chunking: meta, analysis_status: meta.input_truncated ? "partial" : "complete" as const, ...buildDiagnosticMeta({ analysisMode: "model_analysis", modelUsed: true, modelAttempted: true }) },
    };

    const outValidation = validateOutput("aux_review_diff_by_file", output);
    if (!outValidation.ok) {
      log.warn("review-diff-by-file: output validation failed, using fallback");
      return fallbackResult(provider, meta);
    }

    return { content: [{ type: "text", text: JSON.stringify(outValidation.data) }], isError: false };
  }

  function fallbackResult(provider: string, meta: ChunkMeta): CallToolResult {
    const fb = reviewDiffByFileFallback(originalDiff, max_chars_per_file, max_files);
    const output = buildFallbackOutput(fb, provider, meta);
    return { content: [{ type: "text", text: JSON.stringify(output) }], isError: false };
  }
}
