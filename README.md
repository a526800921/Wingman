# Wingman

Claude Code 的僚机 MCP server。像僚机飞在侧翼负责侦察和提醒——做摘要、压缩和 diff 初筛，确保不遗漏明显检查项。结果非权威，主 agent 做最终决策。

## 定位

```
主模型 = 资深工程师做 code review，能看深层设计和架构问题
Wingman = junior 拿着 checklist 逐项打勾——"你确认了 X 吗？有没有漏 Y？"
```

不替代你的判断，而是确保你的判断路径上没有遗漏明显的检查项。

### 模型优先

Wingman 以模型能力作为语义理解核心：模型负责归纳、风险判断和压缩；本地代码只负责安全、确定性结构、调用预算、证据校验和明确降级。新增语言、测试框架或构建工具通常不需要新增专用 parser。完整架构决策见 [ADR-0001：模型优先架构](docs/adr/0001-model-first.md)。

## 工具

| 工具 | 用途 |
|------|------|
| `aux_summarize_file` | 摘要源码/文档/测试文件。自动识别文件类型，按类型输出不同结构 |
| `aux_compress_text` | 压缩日志、错误栈、长文档。适合 >1000 字符的长文本 |
| `aux_review_diff` | 对 unified diff 做提交前 checklist 式审查。适合小 diff |
| `aux_review_diff_by_file` | 按文件/hunk 拆分大 diff 独立分析再汇总。适合多文件大 diff，替代 `aux_review_diff` 对大数据的截断缺陷 |
| `aux_compress_command_output` | 压缩 tsc/eslint/test/build/stack trace 输出。提取首个失败点、文件路径、行号、错误码，归并重复错误 |

## 使用场景

### ✅ 推荐场景

| 场景 | 工具 |
|------|------|
| 长日志 / 错误栈快速定位 | `aux_compress_text` + `focus` |
| 小 diff 提交前 checklist 式扫描 | `aux_review_diff` |
| 多文件大 diff / PR review | `aux_review_diff_by_file` |
| tsc/eslint/test 输出提取首个失败点 | `aux_compress_command_output` |
| 测试文件提取 test_cases 和 covered_behaviors | `aux_summarize_file`（测试文件） |
| 不熟悉的大文件快速了解结构 | `aux_summarize_file` |
| 长构建日志 / stack trace 结构化 | `aux_compress_command_output` |
| 多视角审视同一改动 | `aux_review_diff` 或 `aux_review_diff_by_file` + 不同 `focus` |

### 工具选择指南

| 场景 | 推荐 |
|------|------|
| diff < 3 文件、小改动 | `aux_review_diff` |
| diff 多文件、大改动 | `aux_review_diff_by_file` |
| 命令输出压缩（含首失败点、错误码） | `aux_compress_command_output` |
| 通用长文本压缩 | `aux_compress_text` |

### ❌ 不推荐场景

| 场景 | 原因 |
|------|------|
| 小文件 < 50 行 | 直接读更高效 |
| compress 短文本 < 1000 字符 | 压缩产生不了边际收益 |
| 最终 review 决策 | 结果非权威，有 30% 误报率 |
| 精确符号依赖的重构 | 符号提取可能不完整 |
| 安全审计 | 辅助模型不可信 |

## 安全说明

- 所有工具的 `openWorldHint` annotation 表示输出可能不完整。
- 输出中 `is_authoritative` 永远为 `false`，`must_verify_in_source` 永远为 `true`。
- Claude Code 在编辑、执行 shell 命令、删除文件或做架构决策前**必须**直接回查原文。
- 文件访问限制在 `AUX_WORKSPACE_ROOT` 目录内，拒绝路径穿越。
- prompt injection 多层防护：内容分隔符 + FOCUS_DATA 独立包裹 + stateless 调用 + JSON-only 约束 + schema 校验。

## 安装

```bash
cd E:\work\mcp-local
npm install
npm run build
```

## 配置

### 1. 编辑 `.env`

```env
AUX_MODEL_BASE_URL=https://api.deepseek.com/v1
AUX_MODEL_NAME=deepseek-v4-flash
AUX_MODEL_TIMEOUT_MS=30000
AUX_MODEL_ALLOWED_HOSTS=api.deepseek.com
AUX_LOG_FILE=E:\work\mcp-local\.aux-model.log
AUX_MODEL_API_KEY=你的key
```

### 2. 注册到 Claude Code

```powershell
# 项目级（仅当前项目可用）
claude mcp add -s project wingman -- node E:\work\mcp-local\dist\index.js

# 全局（所有项目可用）
claude mcp add -s user wingman -- node E:\work\mcp-local\dist\index.js
```

`AUX_WORKSPACE_ROOT` 不需要设置——自动取当前项目目录。

### 3. 验证

```powershell
claude mcp list
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AUX_MODEL_API_KEY` | 是* | — | API key（不写入 .mcp.json） |
| `AUX_MODEL_BASE_URL` | 否 | `https://api.deepseek.com/v1` | OpenAI-compatible API 地址 |
| `AUX_MODEL_NAME` | 否 | `deepseek-v4-flash` | 模型名称 |
| `AUX_MODEL_PROVIDER` | 否 | `remote` | 模型来源（remote / local） |
| `AUX_MODEL_TIMEOUT_MS` | 否 | `30000` | 请求超时（毫秒） |
| `AUX_MODEL_ALLOWED_HOSTS` | 否 | — | 允许的 API host（逗号分隔） |
| `AUX_WORKSPACE_ROOT` | 否 | 当前目录 | 文件访问根目录 |
| `AUX_ALLOW_INSECURE_LOCAL_HTTP` | 否 | `false` | 允许本地 http（仅 loopback） |
| `AUX_LOG_LEVEL` | 否 | `info` | 日志级别（debug/info/warn/error） |
| `AUX_LOG_FILE` | 否 | `.aux-model.log` | 日志文件路径，设 `off` 禁用 |

\* 不配置 API key 时，所有工具自动使用**启发式 fallback**，仍然可用。

## 日志

所有日志写入 stderr + 本地文件。默认文件为当前项目下的 `.aux-model.log`，可通过 `AUX_LOG_FILE` 自定义。每条日志含 trace ID 和耗时：

```
[WINGMAN][INFO][...] [a1b2c3d4] summarize_file start {"path":"src/foo.ts"}
[WINGMAN][INFO][...] [a1b2c3d4] chat request completed {"usage":{"total_tokens":1905}}
[WINGMAN][INFO][...] [a1b2c3d4] summarize_file done — 7985ms
```

## 开发

```bash
npm install
npm run build        # tsc 编译
npm run dev          # tsx 直接运行
npm test             # 运行测试（176 条）
npm run smoke        # 冒烟测试（不依赖 API key）
```

覆盖率：78.55% 行覆盖，安全关键路径（workspace/schema/fallback）>90%。

## 项目结构

```
src/
├── index.ts              # MCP server 入口
├── config.ts             # 环境变量读取
├── chat-client.ts        # OpenAI-compatible HTTP client（HTTPS/SSRF/超时/重试）
├── workspace.ts          # 路径安全解析（8 层 Windows 加固）
├── schema.ts             # 输入/输出 Zod schema
├── prompts.ts            # Stateless prompt 构造 + 反注入
├── logger.ts             # stderr + 文件日志（trace ID + 耗时）
├── diagnostics/
│   ├── types.ts          # CommandDiagnostic 内部类型
│   └── tsc-parser.ts     # TypeScript 输出状态机解析器
├── model-runtime/
│   ├── types.ts          # 共享模型执行类型（AnalysisStatus, ModelExecutionMeta）
│   ├── execution.ts      # 模型调用、并发、重试、预算
│   ├── batching.ts       # payload 预算、单次/分批决策
│   ├── evidence.ts       # evidence 精确子串校验
│   ├── status.ts         # 分析状态计算（complete/partial/incomplete）
│   └── truncation.ts     # 智能截断（保留前部和尾部，避免信息丢失）
├── chunking/
│   ├── types.ts          # 分块通用类型（InputChunk, OmittedChunk, ChunkMeta）
│   ├── diff.ts           # Diff 分块（按文件→hunk，优先级排序，省略明细）
│   ├── command-output.ts # 命令输出分块（6 种输出类型识别）
│   └── merge.ts          # 聚合去重、排序、meta 合并
├── fallback/
│   ├── summarize-file.ts # 启发式文件摘要（按文件类型输出不同结构）
│   ├── compress-text.ts  # 启发式文本压缩
│   ├── review-diff.ts    # 启发式 diff review
│   ├── review-diff-by-file.ts # 启发式 per-file diff review
│   └── compress-command-output.ts # 启发式命令输出压缩
└── tools/
    ├── summarize-file.ts # aux_summarize_file handler
    ├── compress-text.ts  # aux_compress_text handler
    ├── review-diff.ts    # aux_review_diff handler
    ├── review-diff-by-file.ts # aux_review_diff_by_file handler
    └── compress-command-output.ts # aux_compress_command_output handler
```

## 兼容性

- Node.js >= 18
- OpenAI-compatible Chat API（DeepSeek、Ollama、LM Studio、vLLM、llama.cpp 等）
- Windows / macOS / Linux

## 分块框架

二期引入统一分块/聚合框架，解决一期对大输入简单前缀截断导致的信息丢失：

```
split → analyze chunk → merge → final result
```

- **Diff 分块**：优先按文件拆分，超大文件再按 hunk 拆分。文件按优先级排序（manifest → 安全敏感 → 源码 → 测试 → 文档），超出 `max_files` 的文件记录省略明细。
- **命令输出分块**：自动识别 6 种输出类型（tsc/eslint/test/build/stack trace/generic），按错误边界拆分，保留后部失败点。
- **聚合**：去重相同发现，保留最高 severity，按 severity → confidence → introduced_by_diff 排序。
- `_meta.chunking` 中记录 `total_chunks`、`analyzed_chunks`、`omitted_chunks` 和省略明细。

> 设计文档：[一期计划](PLAN.md) · [二期计划](PHASE2_PLAN.md) · [二期实施](docs/superpowers/plans/2026-06-20-phase2-implementation.md)

### 三期改进（当前）

在分块框架基础上进一步优化了正确性、延迟和模型成本：

- **TS diagnostic 状态机解析器**（`src/diagnostics/tsc-parser.ts`）：逐行解析 `tsc --noEmit` 输出，将错误首行 + 缩进 detail + code frame 合并为完整 diagnostic 块，支持 pretty 格式和 ANSI 颜色码。消除了一期"14 个真实错误被拆成 23 个 chunk"的问题。
- **Overlay 模型增强**：模型按 opaque `diagnostic_id` 精确匹配 canonical finding，仅覆盖允许增强的字段（message、confidence、actionability），不删除、不复制、不错配确定性字段。模型返回 9/14 条时最终仍保留 14 条。
- **紧凑模型 payload**：模型输入不发送 `evidence`（与 headline/details 重复），仅发送 `id` + `file` + `line` + `column` + `error_code` + `headline` + `details` + `source_kind`，payload 大幅缩小。
- **按需调用模型**：`focus: "errors only"` 或高置信度 parser 场景跳过模型（0 次调用）；需要语义增强时 14 个 diagnostics 合并为 1 个 batch（原来 2 个）。
- **文件级聚合**（`aux_review_diff_by_file`）：模型路径下 `files` 数组完整填充，可按文件区分"已分析/无问题/省略/截断"状态。
- **可操作性排序**：`suggested_source_checks` 按项目源码优先于生成文件/依赖排列，`primary_actionable_failure` 指向最值得优先修复的错误。

> 设计文档：[Phase 2 修复方案](docs/phase2-tools-fix-plan.md) · [回归修复方案](docs/chunk-optimization-regression-fix-plan.md) · [模型 payload 优化](docs/command-output-model-payload-plan.md) · [验证方案](docs/phase2-tools-validation-plan.md) · [P0 落地](docs/phase2-validation-p0-plan.md)

### 文档索引

按主题或问题快速定位到对应的设计文档：

| 主题 | 相关文档 | 说明 |
|------|----------|------|
| 整体架构 / MCP 协议 | [PLAN.md](PLAN.md) | 一期总体设计：工具定位、安全模型、prompt 注入防护 |
| 分块框架 / Diff 按文件审查 | [PHASE2_PLAN.md](PHASE2_PLAN.md) | 二期计划：`aux_review_diff_by_file`、`aux_compress_command_output`、统一分块/聚合 |
| 二期实施步骤 / chunking 模块 | [phase2-implementation](docs/superpowers/plans/2026-06-20-phase2-implementation.md) | 分阶段实施细节、测试策略、subagent 并行开发 |
| Diagnostic 解析 / 14→20 错误拆分 | [修复方案](docs/phase2-tools-fix-plan.md) | 状态机 parser 设计、batch 策略、`_meta` 字段、回归测试矩阵 |
| 数据完整性 / overlay / diagnostic_id | [回归修复](docs/chunk-optimization-regression-fix-plan.md) | canonical finding 不变量、overlay vs 替换、精确 ID 映射、派生字段语义 |
| 模型 payload 精简 / 单批策略 | [payload 优化](docs/command-output-model-payload-plan.md) | 紧凑诊断格式、enrichment 决策、按 payload 分批、enrichment 参数 |
| 模型优先 / 通用命令输出 | [模型优先重构](docs/model-first-command-output-plan.md) | 不依赖专用 parser、evidence 校验、analysis_status、通用分块策略 |
| 全工具模型优先评审 | [全工具评审](docs/model-first-all-tools-review-plan.md) | 5 工具评审、共享 model-runtime、P0-P4 分阶段重构、fallback 重新定义 |
| 核心架构原则 / 模型优先 | [ADR-0001](docs/adr/0001-model-first.md) | 模型与本地代码职责边界、fallback、分块和 adapter 准入条件 |
| 全工具模型优先评审 | [全工具重构计划](docs/model-first-all-tools-review-plan.md) | summarize、compress、review 和 command output 的统一迁移方案 |
| 验证体系 / 样本回放 / 契约断言 | [验证方案](docs/phase2-tools-validation-plan.md) | 真实场景验证框架、匿名化样本库 |
| P0 落地 / 模型预算 / CI 阻断 | [P0 落地方案](docs/phase2-validation-p0-plan.md) | 最小可落地的验证和预算控制

## License

MIT
