# 辅助模型 MCP 计划

## 目标

构建一个供 Claude Code 使用的项目级 MCP server。

Claude Code 仍然是主 agent，负责最终判断、规划、编辑和执行。这个 MCP server 只提供辅助模型工具，用于摘要、压缩上下文和 diff 初筛。

第一版使用可配置的 OpenAI-compatible Chat API。现在可以指向 DeepSeek 云端模型，后续也可以切换到本地模型，不需要改变 MCP 工具协议。

## 非目标

- 不代理或路由 Claude Code 自己的模型请求。
- 不自动决定某个任务应该走云端主模型还是辅助模型。
- 不让辅助模型决定代码编辑、shell 命令、删除、迁移或最终架构方案。
- 第一版不做 embedding、后台索引或 sidecar cache。
- 第一版不做多文件交叉分析、调用链推断或代码库级问答工具。

## 架构

```text
Claude Code 主 agent
  -> 需要时调用 MCP 工具
  -> MCP server 读取受限输入或文件
  -> 辅助模型做摘要、压缩或初筛
  -> MCP server 校验并规范化输出
  -> MCP server 返回结构化的非权威结果
  -> Claude Code 在编辑前回查原文
```

MCP server 以 stdio 进程运行，并通过 Claude Code 的 project scope 配置到具体项目中。

## 模型配置

使用环境变量：

```env
AUX_MODEL_BASE_URL=https://api.deepseek.com/v1
AUX_MODEL_NAME=deepseek-v4-flash
AUX_MODEL_TIMEOUT_MS=30000
AUX_MODEL_ALLOWED_HOSTS=api.deepseek.com
```

API key 不写入 `.mcp.json`。优先从外部 shell 环境或本机未提交的 `.env` 文件读取：

```env
AUX_MODEL_API_KEY=...
```

说明：

- `AUX_MODEL_NAME` 保持可配置，因为 DeepSeek 的实际模型 id 可能不同。
- 这套接口后续也可以兼容 LM Studio、Ollama OpenAI-compatible endpoint、vLLM、llama.cpp server 或其他本地服务。
- 如果没有配置模型，或者 API 调用失败，第一版应该退化到基础启发式摘要，保证 MCP server 仍然可用。
- 日志和错误消息永远不能输出 `Authorization` header、API key 或完整敏感请求体。

## HTTP 安全策略

第一版 HTTP client 独立封装，所有工具只能通过该封装访问模型 API。

默认策略：

- 默认要求 `https://`，避免 API key 明文传输。
- 支持 `AUX_MODEL_ALLOWED_HOSTS`，配置后只允许访问白名单 host。第一版使用 DeepSeek 时建议设置为 `api.deepseek.com`。
- 允许显式开启本地开发例外，例如 `AUX_ALLOW_INSECURE_LOCAL_HTTP=true`，仅允许 loopback 或 localhost。
- 拒绝访问 metadata 地址和私有网段，降低 SSRF 风险，例如 `169.254.169.254`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`。
- 支持请求超时，默认由 `AUX_MODEL_TIMEOUT_MS` 控制。
- 只对网络瞬断、连接超时和 5xx 响应做有限重试；不重试 4xx 响应，避免认证错误或参数错误造成重复消费。
- API 调用失败、超时、非 JSON 响应或输出 schema 校验失败时，自动降级到 fallback。

## 工具

所有工具注册时都声明 MCP annotations：

- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: true`

`openWorldHint` 表示输出可能不完整或不权威。工具输出里仍保留机器可解析字段 `is_authoritative: false`，方便调用方做程序化判断。

### `aux_summarize_file`

摘要源码文件或文档文件。

输入：

- `path`：相对 workspace root 的文件路径。第一版拒绝绝对路径。
- `focus`：可选，关注点或问题。
- `max_chars`：可选，读取字符上限。

输出：

- `summary`
- `important_symbols`
- `evidence`
- `uncertainties`
- `must_verify_in_source`
- `is_authoritative`
- `_meta`

适合用途：

- 在直接阅读关键源码前，先理解大文件的结构。
- 为 Claude Code 准备上下文，但不替代源码阅读。

### `aux_compress_text`

把长文本压缩成结构化上下文。

输入：

- `label`：来源标签。
- `text`：长文本。
- `focus`：可选，关注点或问题。
- `max_chars`：可选，处理字符上限。

输出：

- `summary`
- `key_facts`
- `discarded_or_low_confidence`
- `must_verify_in_source`
- `is_authoritative`
- `_meta`

适合用途：

- 压缩日志、命令输出、长文档或用户粘贴的大段上下文。

### `aux_review_diff`

对 unified diff 做便宜的第一轮 review。

输入：

- `diff`：unified diff 文本。
- `focus`：可选，review 关注点。
- `max_chars`：可选，处理字符上限。

输出：

- `change_summary`
- `possible_risks`
- `suggested_source_checks`
- `suggested_tests`
- `uncertainties`
- `is_authoritative`
- `_meta`

适合用途：

- 第一轮风险扫描。
- Claude Code 仍然负责最终 review，并回查相关原始文件。

## 输出 Schema

模型输出和 fallback 输出必须同构。MCP 工具注册时需要声明 `outputSchema`，工具 handler 返回前也要做运行时校验。

通用结构：

```ts
type Confidence = "high" | "medium" | "low";
type Severity = "low" | "medium" | "high" | "critical";

type Evidence = {
  claim: string;
  source: string;
  confidence?: Confidence;
};

type Uncertainty = {
  topic: string;
  reason: string;
  suggested_verification?: string;
};

type ResultMeta = {
  model: string;
  tokens_used?: number;
  input_truncated: boolean;
  fallback_used: boolean;
};
```

`aux_summarize_file` 额外结构：

```ts
type ImportantSymbol = {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "enum" | "unknown";
  role: string;
  location?: string;
};
```

`aux_review_diff` 额外结构：

```ts
type PossibleRisk = {
  risk: string;
  severity: Severity;
  location?: string;
  explanation?: string;
};
```

## Prompt Injection 防护

辅助模型比 Claude Code 主 agent 更不可信，所有传给辅助模型的内容都按不可信输入处理。

第一版必须包含这些措施：

- 每次模型调用都是 stateless，不复用历史对话。
- system prompt 明确要求忽略用户内容、文件内容或 diff 中出现的指令，只把它们当作待分析数据。
- 用户输入、文件内容、diff 和 `focus` 都使用明确分隔符包裹，不能直接拼接成指令。
- 要求模型只输出 JSON。
- 响应必须通过 JSON parse 和 output schema 校验。
- 非 JSON、字段缺失、字段类型错误或明显越权的输出直接丢弃，降级到 fallback。

安全边界：

```text
辅助模型结果只用于导航、压缩和第一轮筛查。
在编辑代码、运行 shell 命令、删除文件、修改安全敏感行为或做最终架构决策前，
Claude Code 必须直接检查相关原文。
```

## 文件访问范围

第一版默认行为：

- 如果配置了 `AUX_WORKSPACE_ROOT`，文件读取限制在该目录下。
- 如果没有配置 `AUX_WORKSPACE_ROOT`，文件读取限制在 MCP server 启动目录下。
- 只接受相对路径。
- 拒绝读取 workspace root 之外的路径。

环境变量：

```env
AUX_WORKSPACE_ROOT=E:\work\some-project
```

路径解析函数必须覆盖 Windows 边界情况：

1. 拒绝绝对路径，包括 `C:\...`、`E:\...`。
2. 拒绝 UNC 路径，包括 `\\server\share\file`。
3. 拒绝盘符跳转和 drive-relative 路径，例如 `C:foo`。
4. 拒绝 `..` 遍历逃逸。
5. 使用 `fs.realpath` 解析 workspace root 和目标路径，防止 symlink 或 NTFS junction 指向外部。
6. 校验目标真实路径等于 workspace root，或以 `workspaceRoot + path.sep` 开头。
7. 拒绝 NTFS alternate data streams，例如 `file.txt::$DATA`。
8. 拒绝 Windows DOS 设备名，例如 `CON`、`PRN`、`AUX`、`NUL`、`COM1-COM9`、`LPT1-LPT9`。

路径穿越属于安全违规，应该返回 MCP protocol error，例如 invalid params。文件不存在属于普通 tool-level error，返回 `isError: true` 的 tool result。

## 错误处理

错误分类：

| 场景 | 处理方式 |
| --- | --- |
| 输入 schema 不合法 | MCP protocol error |
| 路径穿越或安全违规 | MCP protocol error |
| 文件不存在 | tool-level error，`isError: true` |
| 文件过大且被截断 | 正常 result，`_meta.input_truncated: true` |
| 模型 API 不可用 | 正常 result，使用 fallback，`_meta.fallback_used: true` |
| 模型输出非 JSON 或 schema 不合法 | 正常 result，使用 fallback，`_meta.fallback_used: true` |

## 日志

MCP stdio 的 stdout 被 JSON-RPC 协议占用。实现中不能使用 `console.log()` 输出日志。

日志要求：

- 所有日志写入 stderr。
- 提供统一 logger。
- 默认日志保持简短。
- 日志中不输出 API key、Authorization header、完整源码内容或完整 diff。

## Claude Code 项目级配置

server 构建完成后，在目标项目目录里运行：

```powershell
claude mcp add -s project aux-model `
  -e AUX_MODEL_BASE_URL=https://api.deepseek.com/v1 `
  -e AUX_MODEL_NAME=deepseek-v4-flash `
  -e AUX_MODEL_ALLOWED_HOSTS=api.deepseek.com `
  -e AUX_WORKSPACE_ROOT=E:\work\your-project `
  -- node E:\work\mcp-local\dist\index.js
```

不要通过 `-e AUX_MODEL_API_KEY=...` 把 key 写进项目级 `.mcp.json`。推荐先在 shell 或本机 `.env` 中设置：

```powershell
$env:AUX_MODEL_API_KEY = "your_key_here"
```

这会在当前项目中创建或更新 `.mcp.json`。Claude Code 可能会先把项目级 server 显示为 pending，需要批准后才会连接。

检查配置：

```powershell
claude mcp list
claude mcp get aux-model
```

## 建议项目结构

```text
mcp-local/
├── src/
│   ├── index.ts              # 入口：McpServer + 注册工具 + 启动
│   ├── config.ts             # 环境变量读取和校验
│   ├── chat-client.ts        # OpenAI-compatible HTTP client
│   ├── workspace.ts          # 路径解析和安全沙箱
│   ├── logger.ts             # stderr logger
│   ├── schema.ts             # 输入/输出 schema
│   ├── prompts.ts            # stateless prompt 构造和分隔符策略
│   ├── fallback/
│   │   ├── summarize-file.ts
│   │   ├── compress-text.ts
│   │   └── review-diff.ts
│   └── tools/
│       ├── summarize-file.ts
│       ├── compress-text.ts
│       └── review-diff.ts
├── test/
│   ├── smoke.test.ts
│   ├── workspace.test.ts
│   ├── fallback.test.ts
│   └── tools.test.ts
├── package.json
├── tsconfig.json
├── PLAN.md
└── README.md
```

## 实施步骤

1. 创建 Node + TypeScript 项目骨架。
2. 添加并精确锁定 MCP SDK 版本。
3. 添加统一 stderr logger，禁止 stdout 日志。
4. 实现配置读取，支持 shell 环境和本机 `.env`。
5. 实现 OpenAI-compatible HTTP client，包含 HTTPS 策略、超时、错误分类和敏感信息脱敏。
6. 实现安全的 workspace 路径解析，覆盖 Windows 边界情况。
7. 定义三类工具的 input schema 和 output schema。
8. 实现 prompt injection 防护和 stateless prompt 构造。
9. 实现 fallback 启发式摘要，并保证与模型输出同构。
10. 实现 `aux_summarize_file`。
11. 实现 `aux_compress_text`。
12. 实现 `aux_review_diff`。
13. 添加 README，包含安装、构建、配置、安全说明和使用说明。
14. 添加 smoke test，不依赖模型 key 也能验证工具处理逻辑。
15. 添加 workspace path 单元测试，覆盖 Windows 路径、UNC、`..`、junction/symlink、ADS 和设备名。
16. 添加工具集成测试，mock API 不可用、超时、非 JSON 输出和 schema 不合法。
17. 运行 build 和测试。

## 验收标准

- `npm install` 成功。
- `npm run build` 成功。
- MCP server 可以通过 stdio 启动。
- 三个工具注册了 `readOnlyHint`、`destructiveHint`、`openWorldHint`。
- 三个工具声明 input schema 和 output schema。
- 工具返回结构化 JSON，且模型输出和 fallback 输出同构。
- 没有模型配置时，工具能通过 fallback 行为工作。
- 模型 API 失败、超时、非 JSON 输出或 schema 校验失败时，工具能降级到 fallback。
- 读取 workspace root 之外的文件会被拒绝。
- Windows 路径边界测试通过。
- 日志只写 stderr，不污染 stdout。
- README 包含 Claude Code project-scope 配置命令，并且不建议把 API key 写入 `.mcp.json`。

## 后续版本

- 添加 `aux_query_code` 定向问答工具。
- 添加 sidecar cache，使用 TTL 和文件 hash 失效策略。
- 添加 token 预算和调用次数限制。
- 添加代码和文档的 embedding 检索。
- 添加项目级 prompt profile。
- 添加 Ollama、LM Studio、vLLM、llama.cpp 的本地模型预设。
- 添加进程守护和健康检查。
