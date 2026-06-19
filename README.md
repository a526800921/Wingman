# aux-model MCP Server

供 Claude Code 使用的项目级 MCP server，提供辅助模型工具用于**摘要**、**压缩上下文**和 **diff 初筛**。

Claude Code 仍然是主 agent，负责最终判断、规划、编辑和执行。本 MCP server 的输出是**辅助性、非权威的**。

## 工具

| 工具 | 用途 |
|------|------|
| `aux_summarize_file` | 摘要源码文件或文档文件 |
| `aux_compress_text` | 压缩日志、命令输出、长文本 |
| `aux_review_diff` | 对 unified diff 做第一轮风险扫描 |

## 使用场景

### ✅ 推荐场景

| 场景 | 工具 |
|------|------|
| 长日志 / 错误栈快速定位 | `aux_compress_text` |
| 大 diff 提交前扫描 | `aux_review_diff` |
| 不熟悉的大文件快速了解结构 | `aux_summarize_file` |
| 多视角审视同一改动（切换 focus） | `aux_review_diff` + 不同 `focus` |
| 长文档按关注点过滤 | `aux_compress_text` + `focus` |
| 代码文件提取核心符号 | `aux_summarize_file`（源码文件） |
| Markdown / 文档提取段落结构 | `aux_summarize_file`（文档文件） |
| 测试文件提取测试用例概览 | `aux_summarize_file`（测试文件） |

### ❌ 不推荐场景

| 场景 | 原因 |
|------|------|
| 小文件 < 50 行 | 直接读更高效 |
| 最终 review 决策 | 辅助模型输出非权威，必须回查原文 |
| 精确符号依赖的重构 | 符号提取可能不完整 |
| 安全审计 | 辅助模型不可信，不能代替人工审查 |
| 跨文件调用链分析 | 不在 v1 范围内 |

## 安全说明

- 所有工具的 `openWorldHint` annotation 表示输出可能不完整。
- 输出中包含 `is_authoritative: false` 和 `must_verify_in_source: true` 字段。
- Claude Code 在编辑、执行 shell 命令、删除文件或做架构决策前**必须**直接回查原文。
- 文件访问限制在 `AUX_WORKSPACE_ROOT` 目录内，拒绝路径穿越。
- 辅助模型的 prompt injection 有多层防护（内容分隔符、stateless 调用、JSON-only 约束、schema 校验）。

## 安装

```bash
cd E:\work\mcp-local
npm install
npm run build
```

## 配置

### 1. 编辑 `.env`

项目根目录已有 `.env` 文件（已通过 `.gitignore` 排除），修改其中的 key 和默认值：

```env
AUX_MODEL_BASE_URL=https://api.deepseek.com/v1
AUX_MODEL_NAME=deepseek-v4-flash
AUX_MODEL_TIMEOUT_MS=30000
AUX_MODEL_ALLOWED_HOSTS=api.deepseek.com
AUX_MODEL_API_KEY=你的key
```

`AUX_WORKSPACE_ROOT` 不需要设置——MCP server 会自动取 Claude Code 当前所在的项目目录。

### 2. 注册到 Claude Code 项目

在目标项目目录中运行：

```powershell
claude mcp add -s project aux-model -- node E:\work\mcp-local\dist\index.js
```

> 所有配置已在 `.env` 中，不需要 `-e` 传参。**不要**通过 `-e` 把 API key 写进 `.mcp.json`。

### 3. 验证

```powershell
claude mcp list
claude mcp get aux-model
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AUX_MODEL_API_KEY` | 是* | — | API key（不写入 .mcp.json） |
| `AUX_MODEL_BASE_URL` | 否 | `https://api.deepseek.com/v1` | OpenAI-compatible API 地址 |
| `AUX_MODEL_NAME` | 否 | `deepseek-v4-flash` | 模型名称 |
| `AUX_MODEL_TIMEOUT_MS` | 否 | `30000` | 请求超时（毫秒） |
| `AUX_MODEL_ALLOWED_HOSTS` | 否 | — | 允许的 API host（逗号分隔） |
| `AUX_WORKSPACE_ROOT` | 否 | MCP server 启动目录 | 文件访问根目录 |
| `AUX_ALLOW_INSECURE_LOCAL_HTTP` | 否 | `false` | 允许本地 http（仅 loopback） |
| `AUX_LOG_LEVEL` | 否 | `info` | 日志级别（debug/info/warn/error） |

\* 不配置 API key 时，所有工具自动使用**启发式 fallback**，仍然可用。

## 开发

```bash
npm install
npm run build        # tsc 编译
npm run dev          # tsx 直接运行
npm test             # 运行测试
npm run smoke        # 运行冒烟测试（不依赖 API key）
```

## 项目结构

```
src/
├── index.ts              # MCP server 入口
├── config.ts             # 环境变量读取
├── chat-client.ts        # OpenAI-compatible HTTP client
├── workspace.ts          # 路径安全解析
├── schema.ts             # 输入/输出 Zod schema
├── prompts.ts            # Stateless prompt 构造
├── logger.ts             # stderr logger
├── fallback/
│   ├── summarize-file.ts # 启发式文件摘要
│   ├── compress-text.ts  # 启发式文本压缩
│   └── review-diff.ts    # 启发式 diff review
└── tools/
    ├── summarize-file.ts # aux_summarize_file handler
    ├── compress-text.ts  # aux_compress_text handler
    └── review-diff.ts    # aux_review_diff handler
```

## 兼容性

- Node.js >= 18
- OpenAI-compatible Chat API（DeepSeek、Ollama、LM Studio、vLLM、llama.cpp 等）
- Windows / macOS / Linux

## License

MIT
