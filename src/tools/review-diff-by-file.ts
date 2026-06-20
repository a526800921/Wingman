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
import { sortFindings, deduplicateFindings, buildFindingIdentity } from "../chunking/merge.js";
import { createTraceId, traceLogger, logDuration } from "../logger.js";

type ConfigLike = ReturnType<typeof loadConfig> | ReturnType<typeof loadConfigFallback>;

function hasApiKey(config: ConfigLike): config is AppConfig {
  return "modelApiKey" in config && typeof (config as AppConfig).modelApiKey === "string" && (config as AppConfig).modelApiKey.length > 0;
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
    let fallbackUsed = false;

    if (modelAvailable && chunks.length > 0) {
      try {
        const client = new ChatClient(config as AppConfig);
        const systemPrompt = buildReviewDiffByFileSystemPrompt();
        for (const chunk of chunks) {
          const userMsg = buildReviewDiffByFileUserMessage(
            chunk.text, chunk.source ?? chunk.label, chunk.truncated, focus,
          );
          try {
            const raw = await client.chat(systemPrompt, userMsg);
            const jsonStr = extractJsonFromResponse(raw);
            const parsed = JSON.parse(jsonStr);
            if (parsed && typeof parsed === "object" && parsed.risk && parsed.risk !== "no_issues") {
              allFindings.push({
                risk: String(parsed.risk ?? ""),
                severity: (parsed.severity as DiffFinding["severity"]) ?? "low",
                file: String(parsed.file ?? chunk.source ?? chunk.label),
                hunk: parsed.hunk ? String(parsed.hunk) : undefined,
                location: parsed.location ? String(parsed.location) : undefined,
                explanation: parsed.explanation ? String(parsed.explanation) : undefined,
                evidence: String(parsed.evidence ?? ""),
                introduced_by_diff: typeof parsed.introduced_by_diff === "boolean" ? parsed.introduced_by_diff : undefined,
                confidence: (parsed.confidence as DiffFinding["confidence"]) ?? "medium",
              });
            }
          } catch { /* skip single chunk failure */ }
        }
      } catch (err) {
        log.warn("review-diff-by-file: model failed, using fallback", { error: String(err) });
        fallbackUsed = true;
      }
    }

    if (!modelAvailable || fallbackUsed) {
      const fb = reviewDiffByFileFallback(originalDiff, max_chars_per_file, max_files);
      const fbFindings: DiffFinding[] = [];
      for (const fr of fb.files) {
        for (const f of fr.findings) {
          fbFindings.push({ risk: f.risk, severity: f.severity, file: f.file, hunk: f.hunk, location: f.location, explanation: f.explanation, evidence: f.evidence, introduced_by_diff: f.introduced_by_diff, confidence: f.confidence ?? "medium" });
        }
      }
      const deduped = deduplicateFindings(fbFindings, buildFindingIdentity);
      const sorted = sortFindings(deduped);

      const output: ReviewDiffByFileOutput = {
        overall_summary: fb.overall_summary,
        files: fb.files,
        top_risks: sorted.slice(0, 10),
        omitted_files: fb.omitted_files,
        is_authoritative: false,
        _meta: { provider, model: "heuristic", tokens_used: 0, input_truncated: meta.input_truncated, fallback_used: true, chunking: meta },
      };
      return { content: [{ type: "text", text: JSON.stringify(output) }], isError: false };
    }

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
      const fb = reviewDiffByFileFallback(originalDiff, max_chars_per_file, max_files);
      const fbFindings: DiffFinding[] = [];
      for (const fr of fb.files) for (const f of fr.findings) fbFindings.push({ risk: f.risk, severity: f.severity, file: f.file, hunk: f.hunk, location: f.location, explanation: f.explanation, evidence: f.evidence, introduced_by_diff: f.introduced_by_diff, confidence: f.confidence ?? "medium" });
      return { content: [{ type: "text", text: JSON.stringify({ ...fb, top_risks: fbFindings.slice(0, 10), _meta: { provider, model: "heuristic", tokens_used: 0, input_truncated: meta.input_truncated, fallback_used: true, chunking: meta } }) }], isError: false };
    }

    return { content: [{ type: "text", text: JSON.stringify(outValidation.data) }], isError: false };
  }
}
