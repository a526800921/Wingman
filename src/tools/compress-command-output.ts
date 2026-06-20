import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { hasModelConfig, loadConfig, loadConfigFallback } from "../config.js";
import { ChatClient } from "../chat-client.js";
import {
  validateInput,
  type CompressCommandOutputInput,
  type CompressCommandOutputOutput,
} from "../schema.js";
import {
  buildCompressCommandOutputSystemPrompt,
  buildCompressCommandOutputUserMessage,
  extractJsonFromResponse,
} from "../prompts.js";
import { compressCommandOutputFallback } from "../fallback/compress-command-output.js";
import { chunkCommandOutput } from "../chunking/command-output.js";
import { createTraceId, traceLogger, logDuration } from "../logger.js";

type ConfigLike = ReturnType<typeof loadConfig> | ReturnType<typeof loadConfigFallback>;

function hasApiKey(config: ConfigLike): config is AppConfig {
  return "modelApiKey" in config && typeof (config as AppConfig).modelApiKey === "string" && (config as AppConfig).modelApiKey.length > 0;
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
    const { meta } = chunkCommandOutput(output, max_chars);

    // Always run fallback for structure
    const fb = compressCommandOutputFallback(command, output, exit_code, max_chars);

    let modelFindings = fb.findings;
    let modelUsed = false;

    if (modelAvailable) {
      const client = new ChatClient(config as AppConfig);
      if (!client.isAvailable()) {
        log.info("compress-command-output: ChatClient unavailable, using fallback");
        return buildResult(fb, meta, provider, false);
      }

      const systemPrompt = buildCompressCommandOutputSystemPrompt();
      const { chunks } = chunkCommandOutput(output, max_chars);
      const cappedChunks = chunks.slice(0, 20);

      if (cappedChunks.length > 0) {
        let succeeded = 0;
        const collected: typeof fb.findings = [];
        for (const chunk of cappedChunks) {
          try {
            const userMsg = buildCompressCommandOutputUserMessage(chunk.text, command, exit_code, focus);
            const raw = await client.chat(systemPrompt, userMsg);
            const jsonStr = extractJsonFromResponse(raw);
            const parsed = JSON.parse(jsonStr);
            if (parsed && typeof parsed === "object" && parsed.kind && parsed.kind !== "info") {
              collected.push(parsed as typeof fb.findings[number]);
            }
            succeeded++;
          } catch (err) {
            log.warn("compress-command-output: chunk failed", {
              chunk: chunk.label,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (succeeded === 0 && cappedChunks.length > 0) {
          log.warn("compress-command-output: all chunks failed, using fallback entirely");
        } else if (collected.length > 0) {
          modelFindings = collected;
          modelUsed = true;
        }

        log.info("compress-command-output: model path done", { succeeded, collected: collected.length });
      }
    }

    return buildResult({ ...fb, findings: modelFindings }, meta, provider, modelUsed);
  }

  function buildResult(
    fb: ReturnType<typeof compressCommandOutputFallback>,
    meta: ReturnType<typeof chunkCommandOutput>["meta"],
    provider: string,
    modelUsed: boolean,
  ): CallToolResult {
    const outputData: CompressCommandOutputOutput = {
      summary: fb.summary,
      first_failure: fb.first_failure,
      findings: fb.findings,
      repeated_errors: fb.repeated_errors,
      suggested_source_checks: fb.suggested_source_checks,
      suggested_next_commands: fb.suggested_next_commands,
      discarded_or_low_confidence: fb.discarded_or_low_confidence,
      is_authoritative: false,
      _meta: {
        provider,
        model: modelUsed ? (config as AppConfig).modelName : "heuristic",
        tokens_used: 0,
        input_truncated: meta.input_truncated,
        fallback_used: !modelUsed,
        chunking: meta,
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(outputData) }], isError: false };
  }
}
