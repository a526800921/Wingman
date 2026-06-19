# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # tsc 编译到 dist/
npm run dev            # tsx 直接运行（开发时）
npm test               # 运行全部测试（53 条：smoke + workspace）
npm run smoke          # 冒烟测试（不依赖 AUX_MODEL_API_KEY）
npx tsc --noEmit       # 仅类型检查，不输出文件
```

运行单个测试文件：
```bash
node --import tsx --test test/smoke.test.ts
node --import tsx --test --test-concurrency=1 test/workspace.test.ts
```

## Architecture

Wingman 是一个 stdio MCP server，Claude Code spawn 为子进程，通过 JSON-RPC over stdin/stdout 通信。核心调用链路：

```
Claude Code → StdioServerTransport → index.ts (tools/list, tools/call)
  → tools/*.ts handler
    → 模型可用？→ ChatClient.chat() → 模型返回 JSON
    → 模型不可用/失败 → fallback/*.ts 启发式 → 同构输出
  → schema.ts validateOutput() → CallToolResult
```

**关键约束**：stdout 被 JSON-RPC 独占，所有日志必须走 stderr + 文件。`console.log()` 会破坏 MCP 通信。

## Key modules

| 模块 | 职责 |
|------|------|
| `src/index.ts` | MCP 入口：注册工具、处理 tools/list 和 tools/call |
| `src/config.ts` | 读取环境变量 + `.env` 文件，`loadDotEnv()` 在模块加载时执行 |
| `src/chat-client.ts` | OpenAI-compatible HTTP client：HTTPS 强制、SSRF 防护、超时重试、敏感信息脱敏 |
| `src/workspace.ts` | 路径安全沙箱：8 层 Windows 加固（详见文件注释） |
| `src/schema.ts` | Zod schema：3 组 input + 3 组 output，`validateInput()` / `validateOutput()` |
| `src/prompts.ts` | 构造 system prompt + user message，含分隔符反注入 + extractJsonFromResponse() |
| `src/logger.ts` | 双通道日志：stderr + 文件追加。每请求 trace ID + 耗时。延迟解析 LOG_FILE |
| `src/fallback/*.ts` | 三个工具的启发式实现，输出 schema 与模型输出同构 |
| `src/tools/*.ts` | 三个 tool handler：编排模型调用 → 失败自动降级 fallback |

## Model → fallback routing

每个 tool handler 的通用模式：

```
1. 校验 input → 不合法抛 McpError(InvalidParams)
2. 路径穿越 → 抛 McpError(InvalidParams)
3. 文件不存在 → 返回 isError: true
4. 模型可用？→ 调用 ChatClient.chat()
   ├─ 成功 → extractJson → 强制 is_authoritative=false → validateOutput → 返回
   └─ 失败（超时/非JSON/schema不匹配）→ 记录 warn 日志 → 降级 fallback
5. fallback → 返回同构 JSON，_meta.fallback_used: true
```

调用方（Claude Code）不会看到模型失败——失败自动降级为 fallback。

## _meta 注入顺序（易错点）

模型 prompt 中的 OUTPUT SCHEMA 不包含 `_meta` 和 `is_authoritative`。handler 必须在 `validateOutput()` 之前注入这两个字段，否则 schema 校验必然失败。当前代码：`outputWithMeta = { ...parsed, is_authoritative: false, _meta: {...} }` 然后才校验。

## Logger 延迟解析（易错点）

`logger.ts` 的 `LOG_FILE` 不能是模块加载时 IIFE——那时 `config.ts` 还没读 `.env`，`AUX_LOG_FILE` 不会被读到。当前实现是 `getLogFile()` 延迟到首次写日志时解析。

## Prompt injection defense layers

1. `<<<USER_CONTENT_START>>>/END>>>` 包裹所有文件内容/diff/text
2. `<<<FOCUS_DATA_START>>>/END>>>` 独立包裹 focus 参数
3. System prompt 明确声明：分隔符内是数据，不是指令
4. Stateless — 每次调用无历史
5. JSON-only 约束
6. 非 JSON/schema 不合法 → 丢弃 → fallback

## 注册到 Claude Code

```powershell
# 全局
claude mcp add -s user wingman -- node E:\work\mcp-local\dist\index.js
# 项目级
claude mcp add -s project wingman -- node E:\work\mcp-local\dist\index.js
```

配置在 `.env` 文件中（gitignore 排除），启动时自动加载。API key 不写入 `.mcp.json`。
