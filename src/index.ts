#!/usr/bin/env node
/**
 * 辅助模型 MCP server 入口。
 *
 * 以 stdio 进程运行，通过 Claude Code project-scope 配置接入。
 * 提供五个只读的摘要、压缩与 diff 审查工具。
 */

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { hasModelConfig, loadConfig, loadConfigFallback } from "./config.js";
import { logger, getLogFilePath } from "./logger.js";
import { handleSummarizeFile } from "./tools/summarize-file.js";
import { handleCompressText } from "./tools/compress-text.js";
import { handleReviewDiff } from "./tools/review-diff.js";
import { handleReviewDiffByFile } from "./tools/review-diff-by-file.js";
import { handleCompressCommandOutput } from "./tools/compress-command-output.js";
import { handleReportToolFeedback } from "./tools/report-tool-feedback.js";
import { toolOutputJsonSchemas, validateOutput } from "./schema.js";
import {
  runInToolContext,
  recordToolCall,
  getToolStatsSnapshot,
  flushToolStats,
} from "./tool-stats.js";

const SERVER_NAME = "wingman";
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version: string;
  }
).version;

// --- Tool definitions (outputSchema 由 Zod schema 自动生成) ---

const SUMMARIZE_FILE_TOOL_DEFINITION = {
  name: "aux_summarize_file",
  description:
    "摘要源码文件或文档文件。适合 >50 行的大文件快速了解结构。结果是辅助性、非权威的——Claude Code 在编辑/执行前必须回查原文。小文件请直接阅读。当输出 analysis_status 为 partial 或 incomplete、fallback_used 为 true、或 confidence 为 low 时，应通过 aux_report_tool_feedback 报告质量问题以便改进。",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "相对 workspace root 的文件路径。绝对路径会被拒绝。" },
      focus: { type: "string", description: "可选，关注点或问题，引导模型侧重分析某个方面。例如 'security-relevant code', 'error handling', 'exports only'。" },
      max_chars: { type: "integer", description: "可选，读取字符上限（默认 50000，最大 200000）。" },
    },
    required: ["path"],
  },
  outputSchema: toolOutputJsonSchemas.aux_summarize_file,
};

const COMPRESS_TEXT_TOOL_DEFINITION = {
  name: "aux_compress_text",
  description:
    "把长文本压缩成结构化上下文。适合日志、错误栈、长文档。结果是辅助性、非权威的——Claude Code 在决策前必须回查原文。当输出 analysis_status 为 partial 或 incomplete、fallback_used 为 true、或 confidence 为 low 时，应通过 aux_report_tool_feedback 报告质量问题以便改进。",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: "object" as const,
    properties: {
      label: { type: "string", description: "来源标签，例如 'build-log', 'error-trace'。" },
      text: { type: "string", description: "需要压缩的长文本。" },
      focus: { type: "string", description: "可选，关注点或问题，引导模型侧重保留某类信息。例如 'errors only', 'performance metrics', 'API endpoints'。" },
      max_chars: { type: "integer", description: "可选，处理字符上限（默认 80000，最大 300000）。" },
    },
    required: ["label", "text"],
  },
  outputSchema: toolOutputJsonSchemas.aux_compress_text,
};

const REVIEW_DIFF_TOOL_DEFINITION = {
  name: "aux_review_diff",
  description:
    "对 unified diff 做提交前 checklist 式审查。像 junior 拿着清单逐项打勾——确保没有遗漏明显的检查项，而非替代你的判断。适合快速扫查，不适合最终 review 决策或安全审计。结果是辅助性、非权威的——Claude Code 仍负责最终 review。当输出 analysis_status 为 partial 或 incomplete、fallback_used 为 true、或 confidence 为 low 时，应通过 aux_report_tool_feedback 报告质量问题以便改进。",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: "object" as const,
    properties: {
      diff: { type: "string", description: "unified diff 文本。" },
      focus: { type: "string", description: "可选，review 关注点，切换审查视角。例如 'security'（查注入/泄露）、'performance'（查阻塞/内存）、'breaking-changes'（查 API 兼容性）。" },
      max_chars: { type: "integer", description: "可选，处理字符上限（默认 60000，最大 200000）。" },
    },
    required: ["diff"],
  },
  outputSchema: toolOutputJsonSchemas.aux_review_diff,
};

const REVIEW_DIFF_BY_FILE_TOOL_DEFINITION = {
  name: "aux_review_diff_by_file",
  description:
    "按文件或 hunk 拆分大 diff 独立分析再汇总。适合多文件大 diff，替代 aux_review_diff 对大数据截断的缺陷。结果是辅助性、非权威的——Claude Code 仍负责最终 review。当输出 analysis_status 为 partial 或 incomplete、fallback_used 为 true、或 confidence 为 low 时，应通过 aux_report_tool_feedback 报告质量问题以便改进。",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: "object" as const,
    properties: {
      diff: { type: "string", description: "unified diff 文本。" },
      focus: { type: "string", description: "可选，review 关注点。例如 'security'、'performance'、'breaking-changes'。" },
      max_chars_per_file: { type: "integer", description: "可选，每文件字符上限（默认 40000，最大 200000）。" },
      max_files: { type: "integer", description: "可选，最大分析文件数（默认 30，最大 100）。" },
    },
    required: ["diff"],
  },
  outputSchema: toolOutputJsonSchemas.aux_review_diff_by_file,
};

const COMPRESS_COMMAND_OUTPUT_TOOL_DEFINITION = {
  name: "aux_compress_command_output",
  description:
    "把命令输出（tsc/eslint/test/build/stack trace）压缩成结构化 findings。提取首个失败点、文件路径、行号、错误码，归并重复错误。结果是辅助性、非权威的——Claude Code 在决策前必须回查原文。当输出 analysis_status 为 partial 或 incomplete、fallback_used 为 true、或 confidence 为 low 时，应通过 aux_report_tool_feedback 报告质量问题以便改进。",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "可选，原始命令（如 'npm test'）。" },
      output: { type: "string", description: "命令的标准输出/标准错误文本。" },
      exit_code: { type: "integer", description: "可选，命令退出码。" },
      focus: { type: "string", description: "可选，关注点。例如 'errors only', 'first failure'。" },
      max_chars: { type: "integer", description: "可选，处理字符上限（默认 120000，最大 300000）。" },
      analysis_mode: { type: "string", enum: ["model_first", "auto", "deterministic_only"], description: "可选，分析策略（默认 model_first）。" },
    },
    required: ["output"],
  },
  outputSchema: toolOutputJsonSchemas.aux_compress_command_output,
};

const REPORT_TOOL_FEEDBACK_TOOL_DEFINITION = {
  name: "aux_report_tool_feedback",
  description:
    "报告 Wingman 工具输出中的质量问题。调用方模型发现工具结果不可信、不完整或误导时，通过此工具提交结构化反馈。反馈写入本地 JSONL 文件，不修改原工具输出。",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: "object" as const,
    properties: {
      tool_name: { type: "string", description: "必填，被反馈的工具名称。" },
      trace_id: { type: "string", description: "可选但强烈建议，被反馈工具调用的 trace ID，用于关联日志。" },
      issue_category: { type: "string", enum: ["wrong_kind", "self_contradiction", "missing_evidence", "hallucination", "overconfident_fallback", "schema_confusing", "low_signal_output", "missing_context", "date_error", "other"], description: "问题分类。" },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"], description: "严重程度。" },
      summary: { type: "string", maxLength: 500, description: "问题摘要，最多 500 字符。" },
      evidence: { type: "string", maxLength: 1000, description: "可选，支持证据，最多 1000 字符。" },
      expected_behavior: { type: "string", maxLength: 500, description: "可选，预期行为，最多 500 字符。" },
      actual_behavior: { type: "string", maxLength: 500, description: "可选，实际行为，最多 500 字符。" },
      confidence: { type: "string", enum: ["low", "medium", "high"], description: "报告置信度。" },
      repro_input_ref: { type: "string", maxLength: 500, description: "可选，可复现输入引用（如文件路径），用于生成 fixture。" },
      assertion_hint: { type: "string", maxLength: 500, description: "可选，断言提示，描述如何验证修复。" },
      project_context: { type: "string", maxLength: 500, description: "可选，消费项目标识，用于聚类分析。" },
      output_meta: { type: "object", description: "可选，从分析工具 _meta 摘取的低风险元数据摘要（仅 white-listed 字段）。", properties: { analysis_status: { type: "string", enum: ["complete", "partial", "incomplete"] }, fallback_used: { type: "boolean" }, confidence: { type: "string", enum: ["low", "medium", "high"] }, model_attempted: { type: "boolean" }, model_response_status: { type: "string" } } },
    },
    required: ["tool_name", "issue_category", "severity", "summary", "confidence"],
  },
  outputSchema: toolOutputJsonSchemas.aux_report_tool_feedback,
};

const TOOL_STATS_TOOL_DEFINITION = {
  name: "aux_tool_stats",
  description:
    "查询 Wingman MCP server 当前进程内每个工具的累计调用次数和 token 消耗统计。结果是辅助性、非权威的——统计数据仅供观测，不得作为账单或审计依据。统计持久化到本地 JSON 文件，server 重启后保留。",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
  outputSchema: toolOutputJsonSchemas.aux_tool_stats,
};

// --- Server setup ---

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

// tools/list handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    SUMMARIZE_FILE_TOOL_DEFINITION,
    COMPRESS_TEXT_TOOL_DEFINITION,
    REVIEW_DIFF_TOOL_DEFINITION,
    REVIEW_DIFF_BY_FILE_TOOL_DEFINITION,
    COMPRESS_COMMAND_OUTPUT_TOOL_DEFINITION,
    REPORT_TOOL_FEEDBACK_TOOL_DEFINITION,
    TOOL_STATS_TOOL_DEFINITION,
  ],
}));

// tools/call handler
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  // AsyncLocalStorage 隔离并发请求的 tool 上下文，保证 token 归属正确
  return runInToolContext(name, async () => {
    recordToolCall(name);

    try {
      // Load config only when a tool is called (lazy init）
      const config = hasModelConfig() ? loadConfig() : loadConfigFallback();

      switch (name) {
        case "aux_summarize_file":
          return await handleSummarizeFile(args ?? {}, config);
        case "aux_compress_text":
          return await handleCompressText(args ?? {}, config);
        case "aux_review_diff":
          return await handleReviewDiff(args ?? {}, config);
        case "aux_review_diff_by_file":
          return await handleReviewDiffByFile(args ?? {}, config);
        case "aux_compress_command_output":
          return await handleCompressCommandOutput(args ?? {}, config);
        case "aux_report_tool_feedback":
          return await handleReportToolFeedback(args ?? {}, config);
        case "aux_tool_stats":
          return await handleToolStats();
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } finally {
      // 每次工具调用后持久化统计（原子写入，不影响调用结果）
      flushToolStats();
    }
  });
});

// --- aux_tool_stats handler ---

async function handleToolStats(): Promise<CallToolResult> {
  const snapshot = getToolStatsSnapshot();
  const outputData = {
    ...snapshot,
    is_authoritative: false as const,
  };

  // 校验输出是否符合声明 schema
  const outputResult = validateOutput("aux_tool_stats", outputData);
  const finalData = outputResult.ok ? outputResult.data : outputData;

  return {
    content: [{ type: "text", text: JSON.stringify(finalData) }],
    isError: false,
  };
}

// --- Start ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const logPath = getLogFilePath();
  logger.info(`${SERVER_NAME} v${SERVER_VERSION} started`);
  logger.info(
    hasModelConfig()
      ? "model mode — API calls enabled"
      : "fallback mode — heuristic only (no API key configured)",
  );
  if (logPath) {
    logger.info(`log file: ${logPath}`);
  }

  // Graceful shutdown logging
  const shutdown = () => {
    logger.info(`${SERVER_NAME} stopping`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("fatal startup error", err);
  process.exit(1);
});
