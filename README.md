# Wingman

Wingman 是一个面向编码 Agent 的辅助模型 MCP server。它把大文件、长文本、命令输出和代码 diff 压缩成结构化、可回查的上下文，帮助主 Agent 更快定位重点。

Wingman 不负责最终判断。所有输出均为辅助性结果，调用方在编辑代码、执行命令或作出架构与安全决策前，必须回查原文和源码。

## 核心定位

```text
主 Agent 负责：理解完整上下文、作出决策、实施与验证
Wingman 负责：压缩输入、提取证据、提出风险假设、暴露不确定性
```

Wingman 的价值不是替代主模型，而是用独立的辅助模型减少上下文占用，并提供第二视角。

### 模型优先

Wingman 采用模型优先架构：

```text
模型负责语义理解、归纳、风险判断和压缩
本地代码负责安全、确定性结构、调用预算、证据校验和明确降级
```

新增语言、测试框架或构建工具通常不应要求新增专用 parser。只有格式稳定、场景高频且能够证明准确率、成本或可靠性收益时，才保留确定性 adapter。

完整决策见 [ADR-0001：模型优先架构](https://github.com/a526800921/Wingman/blob/main/docs/adr/0001-model-first.md)。

## 工具定位

| 工具 | 核心意图 | 适合输入 | 不承担的职责 |
|---|---|---|---|
| `aux_summarize_file` | 建立单个大文件的结构与职责认知 | 源码、Markdown、测试文件 | 权威符号索引、依赖分析、重构决策 |
| `aux_compress_text` | 压缩通用非结构化文本 | 长文档、普通日志、错误说明 | 精确诊断、命令失败统计 |
| `aux_compress_command_output` | 从命令输出提取失败点和 evidence | test/build/lint/compiler/stack trace 等任意命令输出 | 自动修复、权威根因判断 |
| `aux_review_diff` | 对小型 unified diff 提出有证据的风险假设 | 小 diff、提交前快速初筛 | 最终 code review、安全审计、合并决策 |
| `aux_review_diff_by_file` | 显式按文件/hunk 审查大型 diff | 多文件大 diff、PR diff | 跨仓库影响分析、完整源码语义 |

### 工具边界

#### `compress_text` 与 `compress_command_output`

- 输入是命令的 stdout/stderr，并且关心失败点、文件、行号、错误码：使用 `aux_compress_command_output`。
- 输入是普通长文本，只需要摘要和关键事实：使用 `aux_compress_text`。

#### `review_diff` 与 `review_diff_by_file`

两个工具表达的是同一个用户意图，区别主要在当前的大输入执行策略：

- 小 diff：使用 `aux_review_diff`，单次模型调用更直接。
- 大型多文件 diff：使用 `aux_review_diff_by_file`，能够记录文件/hunk 的分析与省略状态。

长期方向是将按文件分批变成 `aux_review_diff` 的内部策略，减少调用方选择成本；当前保留两个入口以兼容现有行为。

## 选择指南

| 你的输入 | 推荐工具 |
|---|---|
| 不熟悉的大源码文件 | `aux_summarize_file` |
| 长文档或非命令型日志 | `aux_compress_text` |
| `npm test`、`tsc`、ESLint、构建或运行时输出 | `aux_compress_command_output` |
| 小型 diff | `aux_review_diff` |
| 大型多文件 diff | `aux_review_diff_by_file` |

不建议使用 Wingman 的场景：

- 小文件或短文本，直接阅读更准确；
- 精确符号依赖与 blast-radius 分析，应使用代码图谱或语言工具；
- 最终 code review、架构决策或安全审计；
- 需要确定性结论但无法回查原始证据的任务。

## 执行模型

```text
MCP request
  → 输入 schema 校验
  → 安全清理与确定性结构处理
  → 构造模型 payload
  → 小输入单次调用；超预算后才分批
  → 模型返回结构化 JSON
  → schema / evidence 校验
  → 无损聚合与状态计算
  → 非权威结果
```

模型不可用或调用失败时，工具会进入 heuristic fallback。fallback 只能提供确定性结构和低置信度 signals，不能等同于完整模型分析。

`aux_compress_command_output` 会区分 `valid`、`partial_valid`、`empty`、JSON/schema 失败和 transport failure。非零退出且模型响应不可用时，工具最多进行一次受限修复调用；已有稳定 adapter 的格式可进入 deterministic coverage guard，并明确标记 fallback 和分析状态。

共享模型执行、预算、evidence 和状态能力位于 `src/model-runtime/`。各工具仍处于渐进迁移阶段，具体完成度见[全工具模型优先评审与重构计划](https://github.com/a526800921/Wingman/blob/main/docs/model-first-all-tools-review-plan.md)。

## 可靠性与安全边界

- 所有工具均为只读 MCP 工具。
- 输出中的 `is_authoritative` 固定为 `false`。
- `openWorldHint` 表示输出可能不完整。
- 模型结论必须尽量携带可回查 evidence；无法验证的结论应降级。
- 模型未运行、部分失败和完整成功应使用不同状态表达；该能力正在统一到全部工具。
- `aux_summarize_file` 的文件访问限制在 `AUX_WORKSPACE_ROOT` 内，并拒绝绝对路径与路径穿越。
- Chat client 强制执行 HTTPS（可显式允许本地 loopback HTTP）、SSRF 防护、超时与重试；配置 `AUX_MODEL_ALLOWED_HOSTS` 后还会执行 host allowlist。
- Prompt 使用内容分隔、focus 数据隔离、无状态调用、JSON-only 和 schema 校验降低注入风险。
- 日志写入 stderr 和可选文件，不占用 MCP stdio 的 stdout。

## 安装

### 推荐：npm 全局安装

```bash
npm install -g @jafish/wingman-mcp

# 注册并配置环境变量
claude mcp add -s user wingman \
  -e AUX_MODEL_API_KEY=sk-xxx \
  -e AUX_MODEL_BASE_URL=https://api.deepseek.com/v1 \
  -e AUX_MODEL_NAME=deepseek-v4-flash \
  -e AUX_MODEL_PROVIDER=remote \
  -e AUX_MODEL_ALLOWED_HOSTS=api.deepseek.com \
  -- wingman-mcp
```

本地 OpenAI-compatible 模型也可以直接注册，例如本地 Qwen 服务监听 `8080`：

```bash
claude mcp add -s user wingman \
  -e AUX_MODEL_API_KEY=local \
  -e AUX_MODEL_BASE_URL=http://127.0.0.1:8080/v1 \
  -e AUX_MODEL_NAME=/Users/jafish/Documents/models/Qwen3.6-35B-A3B-4bit \
  -e AUX_MODEL_PROVIDER=local \
  -e AUX_MODEL_TIMEOUT_MS=120000 \
  -e AUX_MODEL_ALLOWED_HOSTS=127.0.0.1,localhost \
  -e AUX_ALLOW_INSECURE_LOCAL_HTTP=true \
  -e AUX_MODEL_DISABLE_THINKING=true \
  -- wingman-mcp
```

或手动编辑配置文件（项目级为项目根目录 `.mcp.json`，用户级为 `~/.claude.json`）：

```json
{
  "mcpServers": {
    "wingman": {
      "command": "wingman-mcp",
      "env": {
        "AUX_MODEL_API_KEY": "sk-xxx",
        "AUX_MODEL_BASE_URL": "https://api.deepseek.com/v1",
        "AUX_MODEL_NAME": "deepseek-v4-flash",
        "AUX_MODEL_ALLOWED_HOSTS": "api.deepseek.com"
      }
    }
  }
}
```

> **注意**：`npx @jafish/wingman-mcp` 在部分环境下存在兼容性问题（`sh: wingman-mcp: command not found`），推荐使用 `npm install -g` 全局安装。`AUX_WORKSPACE_ROOT` 默认为当前工作目录。

### 本地 build（开发 / 自定义模型配置）

```bash
cd /path/to/Wingman
npm install
npm run build
claude mcp add -s project wingman -- node "$(pwd)/dist/index.js"
```

## 配置

Wingman 支持云端模型和本地模型两种接入方式。两者都需要提供 OpenAI-compatible `/v1/chat/completions` 接口；未配置 API key 时会进入 heuristic fallback。

配置默认只读取 MCP 注册时传入的环境变量或 shell 环境变量，不会自动读取当前项目的 `.env`。如需使用 env 文件，显式设置 `AUX_ENV_FILE=/absolute/path/to/.env`。

### 云端模型

环境变量示例：

```env
AUX_MODEL_API_KEY=your-api-key
AUX_MODEL_BASE_URL=https://api.deepseek.com/v1
AUX_MODEL_NAME=deepseek-v4-flash
AUX_MODEL_PROVIDER=remote
AUX_MODEL_TIMEOUT_MS=30000
AUX_MODEL_ALLOWED_HOSTS=api.deepseek.com
AUX_MODEL_DISABLE_THINKING=false
AUX_LOG_FILE=/path/to/Wingman/.aux-model.log
```

环境变量：

| 变量 | 必填 | 默认值 | 说明 |
|---|---:|---|---|
| `AUX_MODEL_API_KEY` | 是* | — | 模型 API key |
| `AUX_MODEL_BASE_URL` | 否 | `https://api.deepseek.com/v1` | OpenAI-compatible API 地址 |
| `AUX_MODEL_NAME` | 否 | `deepseek-v4-flash` | 模型名称 |
| `AUX_MODEL_PROVIDER` | 否 | `remote` | 模型来源标签 |
| `AUX_MODEL_TIMEOUT_MS` | 否 | `30000` | 请求超时，单位毫秒 |
| `AUX_MODEL_ALLOWED_HOSTS` | 否 | — | 允许的 API host，逗号分隔 |
| `AUX_MODEL_DISABLE_THINKING` | 否 | `false` | 为 Qwen 等模型附加 `chat_template_kwargs.enable_thinking=false` |
| `AUX_ENV_FILE` | 否 | — | 显式加载的 env 文件路径；未设置时不会读取 `.env` |
| `AUX_WORKSPACE_ROOT` | 否 | 当前进程目录 | 文件读取根目录 |
| `AUX_ALLOW_INSECURE_LOCAL_HTTP` | 否 | `false` | 仅允许 loopback 的本地 HTTP |
| `AUX_LOG_LEVEL` | 否 | `info` | `debug/info/warn/error` |
| `AUX_LOG_FILE` | 否 | `.aux-model.log` | 设置为 `off` 禁用文件日志 |

\* 未配置 API key 时进入 heuristic fallback。该模式可用于降级和结构信号提取，但不等同于完整模型分析。

### 本地模型

本地模型需要显式允许 loopback HTTP。Qwen thinking 模型通常还需要关闭 thinking，确保服务返回标准 `choices[0].message.content`。

例如 Qwen 服务监听 `8080`：

```env
AUX_MODEL_API_KEY=local
AUX_MODEL_BASE_URL=http://127.0.0.1:8080/v1
AUX_MODEL_NAME=/Users/jafish/Documents/models/Qwen3.6-35B-A3B-4bit
AUX_MODEL_PROVIDER=local
AUX_MODEL_TIMEOUT_MS=120000
AUX_MODEL_ALLOWED_HOSTS=127.0.0.1,localhost
AUX_ALLOW_INSECURE_LOCAL_HTTP=true
AUX_MODEL_DISABLE_THINKING=true
```

## 验证

```bash
claude mcp list
```

`AUX_WORKSPACE_ROOT` 默认取启动 Wingman 进程时的当前目录。全局注册时，应确认宿主是否以目标项目目录启动 MCP；需要固定范围时请显式设置该变量。

## 开发

```bash
npm install
npm run build
npm test
npm run smoke
npm run dev
```

测试包括：

- workspace 与 schema 安全边界；
- command output diagnostic、overlay、调用预算、handler 级恢复和真实 fixture；
- diff chunking 与文件级聚合；
- 无模型配置下的 smoke fallback。

Round 4 真实模型回放连续 3 次均保留 14/14 findings，每次 1 次模型调用且未使用 fallback。脱敏结果见[回放证据](https://github.com/a526800921/Wingman/blob/main/docs/validation/command-output-round4-replay-2026-06-20.md)。

当前测试重点偏向 `aux_compress_command_output`。其他工具的真实模型成功、部分失败、evidence 和大输入回归仍需补齐。

## 项目结构

```text
src/
├── index.ts                 MCP server 与工具注册
├── config.ts                环境变量和 fallback 配置
├── chat-client.ts           OpenAI-compatible client、安全与重试
├── workspace.ts             文件访问边界
├── schema.ts                Zod 输入/输出 schema
├── prompts.ts               无状态 prompt 与响应提取
├── logger.ts                trace 日志
├── model-runtime/           共享模型调用、预算、evidence、状态
├── decoding/                模型响应分层解码与逐 finding 校验
├── diagnostics/             少量确定性 diagnostic adapter
├── chunking/                diff/command-output 结构分块与聚合
├── fallback/                降级结构与 heuristic signals
└── tools/                   五个 MCP handler

test/
├── fixtures/                匿名化真实输入与 expectations
├── helpers/                 fixture runner
└── *.test.ts                单元、契约、预算和 smoke tests
```

## 当前架构评审

### 定位正确的部分

- “辅助模型压缩上下文、主 Agent 最终决策”的总定位正确。
- 文件摘要、通用文本压缩、命令诊断和 diff review 是四种不同用户意图。
- 安全边界、schema、真实 fixture 和非权威标记符合辅助工具定位。
- `model-runtime` 已开始统一模型调用、预算、evidence 和状态。

### 需要继续收敛的部分

- `review_diff_by_file` 长期应成为 `review_diff` 的内部大输入策略。
- fallback 中仍有较多语言、关键词和风险规则，应逐步降级为 validators/signals。
- 各工具的长输入策略和执行元数据尚未完全统一。
- `src/index.ts` 的 MCP JSON schema 与 `src/schema.ts` 手工重复，存在字段漂移风险。
- 测试覆盖集中在 command output，其他模型型工具缺少同等强度的真实 fixture 与失败路径测试。

## 文档

| 文档 | 内容 |
|---|---|
| [计划地图](https://github.com/a526800921/Wingman/blob/main/docs/PLAN_MAP.md) | 计划类型、依赖、状态和推荐实施顺序 |
| [施工计划模板](https://github.com/a526800921/Wingman/blob/main/docs/PLAN_TEMPLATE.md) | 不变量、Step 0 红灯测试、migration 和完成定义 |
| [ADR-0001](https://github.com/a526800921/Wingman/blob/main/docs/adr/0001-model-first.md) | 模型优先架构与 adapter 准入原则 |
| [全工具模型优先评审](https://github.com/a526800921/Wingman/blob/main/docs/model-first-all-tools-review-plan.md) | 五个工具的定位评审和迁移计划 |
| [计划质量评审](https://github.com/a526800921/Wingman/blob/main/docs/plan-quality-review.md) | 7 份设计文档的强项/弱项分析与改进建议 |
| [Command Output 模型优先计划](https://github.com/a526800921/Wingman/blob/main/docs/model-first-command-output-plan.md) | 任意命令输出、evidence 和通用分块 |
| [输出 Schema 迁移](https://github.com/a526800921/Wingman/blob/main/docs/migrations/model-first-output-schema.md) | analysis status、heuristic signals 和 failure 字段迁移 |
| [模型响应契约恢复](https://github.com/a526800921/Wingman/blob/main/docs/plans/command-output-response-contract-recovery.md) | **已完成** — Round 4 分层校验、null 规范化、非零退出恢复 |
| [Round 4 回放证据](https://github.com/a526800921/Wingman/blob/main/docs/validation/command-output-round4-replay-2026-06-20.md) | 3 次真实模型回放的脱敏状态、计数和门禁结果 |
| [真实场景验证方案](https://github.com/a526800921/Wingman/blob/main/docs/phase2-tools-validation-plan.md) | fixtures、契约、模型评测与 Shadow 验证 |
| [Phase 2 计划](https://github.com/a526800921/Wingman/blob/main/PHASE2_PLAN.md) | 分块框架与新增工具的原始设计 |

## 兼容性

- Node.js 18+
- OpenAI-compatible Chat API
- macOS

## License

MIT
