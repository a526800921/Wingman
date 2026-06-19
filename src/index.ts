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
import { logger } from "./logger.js";
import { handleSummarizeFile } from "./tools/summarize-file.js";
import { handleCompressText } from "./tools/compress-text.js";
import { handleReviewDiff } from "./tools/review-diff.js";

const SERVER_NAME = "aux-model";
const SERVER_VERSION = "0.1.0";

// --- Tool definitions (inputSchema for tools/list) ---

const SUMMARIZE_FILE_TOOL_DEFINITION = {
  name: "aux_summarize_file",
  description:
    "摘要源码文件或文档文件。结果是辅助性、非权威的——Claude Code 在编辑/执行前必须回查原文。",
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
        description: "可选，关注点或问题。",
      },
      max_chars: {
        type: "integer",
        description: "可选，读取字符上限（默认 50000，最大 200000）。",
      },
    },
    required: ["path"],
  },
};

const COMPRESS_TEXT_TOOL_DEFINITION = {
  name: "aux_compress_text",
  description:
    "把长文本压缩成结构化上下文。结果是辅助性、非权威的——Claude Code 在决策前必须回查原文。",
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
        description: "可选，关注点或问题。",
      },
      max_chars: {
        type: "integer",
        description: "可选，处理字符上限（默认 80000，最大 300000）。",
      },
    },
    required: ["label", "text"],
  },
};

const REVIEW_DIFF_TOOL_DEFINITION = {
  name: "aux_review_diff",
  description:
    "对 unified diff 做便宜的第一轮 review。结果是辅助性、非权威的——Claude Code 仍负责最终 review。",
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
        description: "可选，review 关注点，例如 'security', 'performance'。",
      },
      max_chars: {
        type: "integer",
        description: "可选，处理字符上限（默认 60000，最大 200000）。",
      },
    },
    required: ["diff"],
  },
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
  logger.info(`${SERVER_NAME} v${SERVER_VERSION} started`);
  logger.info(
    hasModelConfig()
      ? "model mode — API calls enabled"
      : "fallback mode — heuristic only (no API key configured)",
  );
}

main().catch((err) => {
  logger.error("fatal startup error", err);
  process.exit(1);
});
