import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { hasModelConfig, loadConfig, loadConfigFallback } from "../config.js";
import { ChatClient } from "../chat-client.js";
import {
  validateInput,
  validateOutput,
  type ReviewDiffByFileInput,
  type ReviewDiffByFileOutput,
  type DiffFinding,
} from "../schema.js";
import {
  buildReviewDiffByFileSystemPrompt,
  buildReviewDiffByFileUserMessage,
  extractJsonFromResponse,
} from "../prompts.js";
import { reviewDiffByFileFallback } from "../fallback/review-diff-by-file.js";
import { chunkDiff } from "../chunking/diff.js";
import type { ChunkMeta } from "../chunking/types.js";
import { sortFindings, deduplicateFindings, buildFindingIdentity } from "../chunking/merge.js";
import { createTraceId, traceLogger, logDuration } from "../logger.js";

type ConfigLike = ReturnType<typeof loadConfig> | ReturnType<typeof loadConfigFallback>;

function hasApiKey(config: ConfigLike): config is AppConfig {
  return "modelApiKey" in config && typeof (config as AppConfig).modelApiKey === "string" && (config as AppConfig).modelApiKey.length > 0;
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
    is_authoritative: false,
    _meta: {
      provider,
      model: "heuristic",
      tokens_used: 0,
      input_truncated: meta.input_truncated,
      fallback_used: true,
      chunking: meta,
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

    if (modelAvailable && chunks.length > 0) {
      const client = new ChatClient(config as AppConfig);

      if (!client.isAvailable()) {
        log.info("review-diff-by-file: ChatClient unavailable, using fallback");
        return fallbackResult(provider, meta);
      }

      let succeededChunks = 0;
      let failedChunks = 0;

      const systemPrompt = buildReviewDiffByFileSystemPrompt();
      for (const chunk of chunks) {
        const chunkLabel = chunk.source ?? chunk.label;
        const userMsg = buildReviewDiffByFileUserMessage(
          chunk.text, chunkLabel, chunk.truncated, focus,
        );
        try {
          const raw = await client.chat(systemPrompt, userMsg);
          const jsonStr = extractJsonFromResponse(raw);
          const parsed = JSON.parse(jsonStr);
          if (parsed && typeof parsed === "object" && parsed.risk && parsed.risk !== "no_issues") {
            allFindings.push({
              risk: String(parsed.risk ?? ""),
              severity: (parsed.severity as DiffFinding["severity"]) ?? "low",
              file: String(parsed.file ?? chunkLabel),
              hunk: parsed.hunk ? String(parsed.hunk) : undefined,
              location: parsed.location ? String(parsed.location) : undefined,
              explanation: parsed.explanation ? String(parsed.explanation) : undefined,
              evidence: String(parsed.evidence ?? ""),
              introduced_by_diff: typeof parsed.introduced_by_diff === "boolean" ? parsed.introduced_by_diff : undefined,
              confidence: (parsed.confidence as DiffFinding["confidence"]) ?? "medium",
            });
          }
          succeededChunks++;
        } catch (err) {
          failedChunks++;
          log.warn("review-diff-by-file: chunk model call failed", {
            chunk: chunkLabel,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // If every chunk failed, fall back entirely to heuristic
      if (succeededChunks === 0 && failedChunks > 0) {
        log.warn("review-diff-by-file: all chunks failed, falling back to heuristic", { failedChunks });
        return fallbackResult(provider, meta);
      }

      log.info("review-diff-by-file: model path done", { succeededChunks, failedChunks, findings: allFindings.length });
    }

    if (!modelAvailable) {
      return fallbackResult(provider, meta);
    }

    // Model path succeeded — validate and return
    const deduped = deduplicateFindings(allFindings, buildFindingIdentity);
    const sorted = sortFindings(deduped);

    const output: ReviewDiffByFileOutput = {
      overall_summary: `Model review of ${chunks.length} chunk(s). ${sorted.length} finding(s).`,
      files: [],
      top_risks: sorted.slice(0, 10),
      omitted_files: meta.omitted.map(o => ({ file: o.source ?? o.label, reason: o.reason })),
      is_authoritative: false,
      _meta: { provider, model: (config as AppConfig).modelName, input_truncated: meta.input_truncated, fallback_used: false, chunking: meta },
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
