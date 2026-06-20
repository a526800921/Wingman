/**
 * 辅助模型 MCP server 入口。
 *
 * 以 stdio 进程运行，通过 Claude Code project-scope 配置接入。
 * 提供 aux_summarize_file、aux_compress_text、aux_review_diff 三个工具。
 */

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

const SERVER_NAME = "wingman";
const SERVER_VERSION = "0.1.0";

// --- Tool definitions (inputSchema for tools/list) ---

const SUMMARIZE_FILE_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    summary: { type: "string" },
    important_symbols: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: ["function", "class", "interface", "type", "const", "enum", "unknown"] },
          role: { type: "string" },
          location: { type: "string" },
        },
      },
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          source: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    uncertainties: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          reason: { type: "string" },
          suggested_verification: { type: "string" },
        },
      },
    },
    must_verify_in_source: { type: "boolean" },
    is_authoritative: { type: "boolean", const: false },
    _meta: {
      type: "object",
      properties: {
        model: { type: "string" },
        tokens_used: { type: "integer" },
        input_truncated: { type: "boolean" },
        fallback_used: { type: "boolean" },
      },
    },
  },
  required: ["summary", "must_verify_in_source", "is_authoritative", "_meta"],
};

const SUMMARIZE_FILE_TOOL_DEFINITION = {
  name: "aux_summarize_file",
  description:
    "摘要源码文件或文档文件。适合 >50 行的大文件快速了解结构。结果是辅助性、非权威的——Claude Code 在编辑/执行前必须回查原文。小文件请直接阅读。",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "相对 workspace root 的文件路径。绝对路径会被拒绝。",
      },
      focus: {
        type: "string",
        description: "可选，关注点或问题，引导模型侧重分析某个方面。例如 'security-relevant code', 'error handling', 'exports only'。",
      },
      max_chars: {
        type: "integer",
        description: "可选，读取字符上限（默认 50000，最大 200000）。",
      },
    },
    required: ["path"],
  },
  outputSchema: SUMMARIZE_FILE_OUTPUT_SCHEMA,
};

const COMPRESS_TEXT_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    summary: { type: "string" },
    key_facts: { type: "array", items: { type: "string" } },
    discarded_or_low_confidence: { type: "array", items: { type: "string" } },
    must_verify_in_source: { type: "boolean" },
    is_authoritative: { type: "boolean", const: false },
    _meta: {
      type: "object",
      properties: {
        model: { type: "string" },
        tokens_used: { type: "integer" },
        input_truncated: { type: "boolean" },
        fallback_used: { type: "boolean" },
      },
    },
  },
  required: ["summary", "must_verify_in_source", "is_authoritative", "_meta"],
};

const COMPRESS_TEXT_TOOL_DEFINITION = {
  name: "aux_compress_text",
  description:
    "把长文本压缩成结构化上下文。适合日志、错误栈、长文档。结果是辅助性、非权威的——Claude Code 在决策前必须回查原文。",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      label: {
        type: "string",
        description: "来源标签，例如 'build-log', 'error-trace'。",
      },
      text: {
        type: "string",
        description: "需要压缩的长文本。",
      },
      focus: {
        type: "string",
        description: "可选，关注点或问题，引导模型侧重保留某类信息。例如 'errors only', 'performance metrics', 'API endpoints'。",
      },
      max_chars: {
        type: "integer",
        description: "可选，处理字符上限（默认 80000，最大 300000）。",
      },
    },
    required: ["label", "text"],
  },
  outputSchema: COMPRESS_TEXT_OUTPUT_SCHEMA,
};

const REVIEW_DIFF_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    change_summary: { type: "string" },
    possible_risks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          risk: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          location: { type: "string" },
          explanation: { type: "string" },
        },
      },
    },
    suggested_source_checks: { type: "array", items: { type: "string" } },
    suggested_tests: { type: "array", items: { type: "string" } },
    uncertainties: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          reason: { type: "string" },
          suggested_verification: { type: "string" },
        },
      },
    },
    is_authoritative: { type: "boolean", const: false },
    _meta: {
      type: "object",
      properties: {
        model: { type: "string" },
        tokens_used: { type: "integer" },
        input_truncated: { type: "boolean" },
        fallback_used: { type: "boolean" },
      },
    },
  },
  required: ["change_summary", "is_authoritative", "_meta"],
};

const REVIEW_DIFF_TOOL_DEFINITION = {
  name: "aux_review_diff",
  description:
    "对 unified diff 做提交前 checklist 式审查。像 junior 拿着清单逐项打勾——确保没有遗漏明显的检查项，而非替代你的判断。适合快速扫查，不适合最终 review 决策或安全审计。结果是辅助性、非权威的——Claude Code 仍负责最终 review。",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      diff: {
        type: "string",
        description: "unified diff 文本。",
      },
      focus: {
        type: "string",
        description: "可选，review 关注点，切换审查视角。例如 'security'（查注入/泄露）、'performance'（查阻塞/内存）、'breaking-changes'（查 API 兼容性）。",
      },
      max_chars: {
        type: "integer",
        description: "可选，处理字符上限（默认 60000，最大 200000）。",
      },
    },
    required: ["diff"],
  },
  outputSchema: REVIEW_DIFF_OUTPUT_SCHEMA,
};

const REVIEW_DIFF_BY_FILE_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    overall_summary: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          change_summary: { type: "string" },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                risk: { type: "string" },
                severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
                file: { type: "string" },
                hunk: { type: "string" },
                location: { type: "string" },
                explanation: { type: "string" },
                evidence: { type: "string" },
                introduced_by_diff: { type: "boolean" },
                confidence: { type: "string", enum: ["low", "medium", "high"] },
              },
            },
          },
          suggested_source_checks: { type: "array", items: { type: "string" } },
          suggested_tests: { type: "array", items: { type: "string" } },
          uncertainties: {
            type: "array",
            items: {
              type: "object",
              properties: {
                topic: { type: "string" },
                reason: { type: "string" },
                suggested_verification: { type: "string" },
              },
            },
          },
        },
      },
    },
    top_risks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          risk: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          file: { type: "string" },
          hunk: { type: "string" },
          location: { type: "string" },
          explanation: { type: "string" },
          evidence: { type: "string" },
          introduced_by_diff: { type: "boolean" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    omitted_files: {
      type: "array",
      items: {
        type: "object",
        properties: { file: { type: "string" }, reason: { type: "string" } },
      },
    },
    is_authoritative: { type: "boolean", const: false },
    _meta: {
      type: "object",
      properties: {
        provider: { type: "string" },
        model: { type: "string" },
        tokens_used: { type: "integer" },
        input_truncated: { type: "boolean" },
        fallback_used: { type: "boolean" },
        chunking: {
          type: "object",
          properties: {
            total_chunks: { type: "integer" },
            analyzed_chunks: { type: "integer" },
            omitted_chunks: { type: "integer" },
            omitted: { type: "array", items: { type: "object" } },
            input_truncated: { type: "boolean" },
            chunking_strategy: { type: "string" },
          },
        },
        files_analyzed: { type: "integer" },
        files_omitted: { type: "integer" },
      },
    },
  },
  required: ["overall_summary", "files", "top_risks", "is_authoritative", "_meta"],
};

const COMPRESS_COMMAND_OUTPUT_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    summary: { type: "string" },
    first_failure: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["test_failure", "type_error", "lint_error", "build_error", "runtime_exception", "warning", "info", "unknown"] },
        message: { type: "string" },
        error_code: { type: "string" },
        rule_id: { type: "string" },
        file: { type: "string" },
        line: { type: "integer" },
        column: { type: "integer" },
        evidence: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        first_seen_index: { type: "integer" },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["test_failure", "type_error", "lint_error", "build_error", "runtime_exception", "warning", "info", "unknown"] },
          message: { type: "string" },
          error_code: { type: "string" },
          rule_id: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          column: { type: "integer" },
          evidence: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          first_seen_index: { type: "integer" },
        },
      },
    },
    repeated_errors: {
      type: "array",
      items: {
        type: "object",
        properties: { message: { type: "string" }, count: { type: "integer" }, examples: { type: "array", items: { type: "string" } } },
      },
    },
    suggested_source_checks: { type: "array", items: { type: "string" } },
    suggested_next_commands: { type: "array", items: { type: "string" } },
    discarded_or_low_confidence: { type: "array", items: { type: "string" } },
    is_authoritative: { type: "boolean", const: false },
    primary_actionable_failure: {
      type: "object",
      properties: {
        kind: { type: "string" }, message: { type: "string" },
        file: { type: "string" }, line: { type: "integer" },
        error_code: { type: "string" }, evidence: { type: "string" },
        confidence: { type: "string" },
      },
    },
    _meta: {
      type: "object",
      properties: {
        provider: { type: "string" },
        model: { type: "string" },
        tokens_used: { type: "integer" },
        input_truncated: { type: "boolean" },
        fallback_used: { type: "boolean" },
        chunking: { type: "object" },
        diagnostics_parsed: { type: "integer" },
        findings_retained: { type: "integer" },
        candidate_batches: { type: "integer" },
        batches_sent: { type: "integer" },
        batches_succeeded: { type: "integer" },
        batches_failed: { type: "integer" },
        batches_omitted_by_budget: { type: "integer" },
        model_findings_received: { type: "integer" },
        model_enhancements_applied: { type: "integer" },
        unknown_diagnostic_ids: { type: "integer" },
      },
    },
  },
  required: ["summary", "findings", "is_authoritative", "_meta"],
};

const REVIEW_DIFF_BY_FILE_TOOL_DEFINITION = {
  name: "aux_review_diff_by_file",
  description:
    "按文件或 hunk 拆分大 diff 独立分析再汇总。适合多文件大 diff，替代 aux_review_diff 对大数据截断的缺陷。结果是辅助性、非权威的——Claude Code 仍负责最终 review。",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
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
  outputSchema: REVIEW_DIFF_BY_FILE_OUTPUT_SCHEMA,
};

const COMPRESS_COMMAND_OUTPUT_TOOL_DEFINITION = {
  name: "aux_compress_command_output",
  description:
    "把命令输出（tsc/eslint/test/build/stack trace）压缩成结构化 findings。提取首个失败点、文件路径、行号、错误码，归并重复错误。结果是辅助性、非权威的——Claude Code 在决策前必须回查原文。",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "可选，原始命令（如 'npm test'）。" },
      output: { type: "string", description: "命令的标准输出/标准错误文本。" },
      exit_code: { type: "integer", description: "可选，命令退出码。" },
      focus: { type: "string", description: "可选，关注点。例如 'errors only', 'first failure'。" },
      max_chars: { type: "integer", description: "可选，处理字符上限（默认 120000，最大 300000）。" },
    },
    required: ["output"],
  },
  outputSchema: COMPRESS_COMMAND_OUTPUT_OUTPUT_SCHEMA,
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
  ],
}));

// tools/call handler
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  // Load config only when a tool is called (lazy init）
  const config = hasModelConfig() ? loadConfig() : loadConfigFallback();

  let result: CallToolResult;

  switch (name) {
    case "aux_summarize_file":
      result = await handleSummarizeFile(args ?? {}, config);
      break;
    case "aux_compress_text":
      result = await handleCompressText(args ?? {}, config);
      break;
    case "aux_review_diff":
      result = await handleReviewDiff(args ?? {}, config);
      break;
    case "aux_review_diff_by_file":
      result = await handleReviewDiffByFile(args ?? {}, config);
      break;
    case "aux_compress_command_output":
      result = await handleCompressCommandOutput(args ?? {}, config);
      break;
    default:
      result = {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }

  return result;
});

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
