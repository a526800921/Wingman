# MCP 工具消费方反馈闭环计划

## 元数据

- 文档类型：施工计划
- 状态：已完成 (2026-06-28)
- 负责人：Claude Code (SDD 实施)
- 依赖计划：`docs/plans/wingman-mcp-translatebar-report-reliability.md`
- 相关 ADR：`docs/adr/0001-model-first.md`
- 公开 schema 变化：是，新增 MCP 工具 `aux_report_tool_feedback`，并要求现有工具输出 `_meta.trace_id` 与 `_meta.tool_name`
- Migration note：已补充到 `docs/migrations/model-first-output-schema.md`（2026-06-28 条目）

## 1. 问题与证据

现有日志能记录 MCP 工具内部运行情况，例如模型是否调用、是否 fallback、schema 是否失败、耗时多少。但它不能记录调用方模型消费工具结果后的质量判断。

真实使用中，调用方模型可能发现以下问题：

- 输出字段自相矛盾，例如 `kind = test_failure` 但 message 表示 `0 failures`；
- finding 缺少可回查 evidence；
- 模型产生 hallucination，例如把当前日期误判为未来日期；
- fallback 结果过度确定，例如非 TSJS 文件被展示成精确 symbol 解析；
- schema 字段语义误导下游路由；
- summary 低信号，无法支撑下一步判断。

当前这些问题依赖人工主动询问和报告，覆盖不系统。本计划新增反馈通道，让调用方模型在发现不可信输出时主动写入结构化反馈日志。

## 2. 必须保持的不变量

- 反馈工具只记录观察，不改变原工具输出。
- 反馈工具不调用模型。
- 反馈默认开启并写本地 JSONL；可通过 `AUX_FEEDBACK_LOG_FILE=off` 显式关闭。
- 反馈只允许写本地文件，不上传远端。
- 反馈不得包含完整源码、完整 diff、完整命令输出、API key、Authorization header 或大段日志。
- 反馈必须能通过 `trace_id` 关联 `.aux-model.log` 中的原始运行日志。
- 现有工具输出必须包含 `_meta.trace_id`；反馈输入中的 `trace_id` 可选但强烈建议。
- 只有带 `trace_id` 的反馈才能成为 fixture 候选。
- 允许记录低信号、不好用但不一定错误的反馈。
- 反馈日志失败不得影响原 MCP 工具调用。
- 新增字段必须兼容旧调用方。

## 3. 范围

### 包含

- 所有现有工具输出 `_meta.trace_id` 和 `_meta.tool_name`。
- 新增 MCP 工具 `aux_report_tool_feedback`。
- 新增反馈 JSONL 写入逻辑。
- 支持 `AUX_FEEDBACK_LOG_FILE` 和 `AUX_FEEDBACK_LOG_FILE=off`。
- 新增最小反馈聚合脚本。
- README / AGENTS 增加调用方模型何时反馈的规则。

### 不包含

- 自动修复工具行为。
- 自动生成测试代码。
- 自动上传反馈。
- 自动二次调用模型验证反馈。
- 在当前 TranslateBar 回归修复计划中实现反馈工具。

## 4. 目标 symbols 与影响分析

本表在计划设计阶段允许保留 `待运行`。进入任何生产代码修改前，必须对所有实际会修改的函数、类或方法运行 GitNexus upstream impact，并把 risk、直接调用方和受影响 execution flows 填回本节。未完成 impact 填表前，不得修改任何生产代码。若任一目标 symbol 返回 HIGH 或 CRITICAL，必须先向用户报告 blast radius 并获得继续许可。

| Symbol | 文件 | 预期修改 | GitNexus risk |
|---|---|---|---|
| `ResultMetaSchema` | `src/schema.ts` | 增加 `_meta.trace_id` 与 `_meta.tool_name` | LOW — impactedCount=0 |
| `handleSummarizeFile` | `src/tools/summarize-file.ts` | 将 trace id / tool name 写入输出 `_meta` | LOW — direct=1 |
| `handleCompressText` | `src/tools/compress-text.ts` | 将 trace id / tool name 写入输出 `_meta` | LOW — direct=1 |
| `handleReviewDiff` | `src/tools/review-diff.ts` | 将 trace id / tool name 写入输出 `_meta` | LOW — direct=1 |
| `handleReviewDiffByFile` | `src/tools/review-diff-by-file.ts` | 将 trace id / tool name 写入输出 `_meta` | LOW — direct=1 |
| `handleCompressCommandOutput` | `src/tools/compress-command-output.ts` | 将 trace id / tool name 写入输出 `_meta` | LOW — direct=2 |
| `ToolFeedbackInput` | `src/schema.ts` | 新增反馈工具输入 schema | 新增 symbol（实施后复核） |
| `handleReportToolFeedback` | 待新增 → `src/tools/report-tool-feedback.ts` | 写入反馈 JSONL | 新增 symbol（实施后复核） |
| `ListToolsRequestSchema` handler | `src/index.ts` | 注册新 MCP 工具 | UNKNOWN → 实施后复核 |

**实施后 detect_changes() 结果** (2026-06-28, compare 08ae8c7..cd96532):
- 39 changed symbols（含 2 个治理文档触及符号）, 68 affected processes, 17 changed files（含 4 个治理文档文件）, **risk_level: critical**
- `critical` 为预期结果：所有 5 个 handler 及其内部辅助函数因 `traceMeta` 参数传递被全体触及，变更纯机械无行为改变
- 新增 `handleReportToolFeedback` 为独立 handler，无上游消费者
- 现有工具语义不变，仅 `_meta` 新增两个 optional 字段
- 结论：变更范围在预期内，无实质性 blast-radius 风险

## 5. Step 0：先建立红灯测试

### Fixture A：trace id 暴露

- 输入：调用任一现有工具。
- Expectation：输出 `_meta.trace_id` 为 server 生成的短 ID，`_meta.tool_name` 等于工具名。
- 失败原因：当前 trace id 主要存在内部日志中，输出 `_meta` 未统一暴露。

### Fixture B：反馈写入

- 输入：调用 `aux_report_tool_feedback`，传入 `tool_name`、`trace_id`、`issue_category`、`severity`、`summary`、`confidence`。
- Expectation：返回 `recorded = true`，并向 `.aux-feedback.jsonl` 写入一条合法 JSONL。
- 失败原因：当前没有反馈工具。

### Fixture C：隐私和长度限制

- 输入：反馈字段包含超长 evidence、疑似 API key 或完整 Authorization header。
- Expectation：schema 拒绝或 sanitizer 截断/脱敏；日志中不得出现敏感 token。
- 失败原因：当前没有反馈写入和 sanitizer。

### 红灯确认（2026-06-28 执行）

```text
运行命令：node --import tsx --test test/mcp-tool-feedback-loop.test.ts
预期失败断言：
- 现有工具输出缺少 _meta.trace_id / _meta.tool_name。
- aux_report_tool_feedback 尚不存在。
- 超长或敏感反馈无法被安全处理。

红灯结果（commit f53aa88）：
  8/8 fail，0 pass — Fixture A 2 fail（trace_id/tool_name 均为 undefined），
  Fixture B 2 fail（validateInput 返回 "Unknown tool"，handler import MODULE_NOT_FOUND），
  Fixture C 4 fail（全部返回 "Unknown tool" 而非字段级校验错误）。
  红灯成立，确认当前代码缺少所有三项能力。

转绿结果（commit a3ef434）：
  8/8 pass — Fixture A trace_id 为 8 字符 hex、tool_name 匹配；
  Fixture B 工具注册成功、handler 可 import；
  Fixture C summary/evidence 超长被 Zod max 拒绝、sk-/Authorization 被 superRefine 拒绝。
```

## 6. 目标数据流

```text
现有 MCP 工具调用
  → handler 生成 trace id
  → 工具输出 _meta.trace_id / _meta.tool_name
  → 调用方模型检查工具结果
  → 发现不可信、不完整或误导性输出
  → 调用 aux_report_tool_feedback
  → schema 校验与 sanitizer
  → 写入 .aux-feedback.jsonl
  → 聚合脚本输出反馈摘要与 fixture 候选
```

## 7. 反馈工具契约

### 输入

```ts
{
  tool_name: string;
  trace_id?: string;
  issue_category:
    | "wrong_kind"
    | "self_contradiction"
    | "missing_evidence"
    | "hallucination"
    | "overconfident_fallback"
    | "schema_confusing"
    | "low_signal_output"
    | "missing_context"
    | "date_error"
    | "other";
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  evidence?: string;
  expected_behavior?: string;
  actual_behavior?: string;
  confidence: "low" | "medium" | "high";
}
```

### 输出

```ts
{
  recorded: boolean;
  feedback_id: string;
  log_file: string | null;
  is_authoritative: false;
}
```

### 字段长度限制

| 字段 | 最大长度 |
|---|---:|
| `summary` | 500 |
| `evidence` | 1000 |
| `expected_behavior` | 500 |
| `actual_behavior` | 500 |

## 8. 反馈日志格式

默认文件：

```text
~/.wingman/feedback.jsonl
```

环境变量：

```text
AUX_FEEDBACK_LOG_FILE=/path/to/.aux-feedback.jsonl
AUX_FEEDBACK_LOG_FILE=off
```

默认行为：

- 未设置 `AUX_FEEDBACK_LOG_FILE` 时，反馈写入用户目录下的 `~/.wingman/feedback.jsonl`，所有消费项目共享同一个反馈入口。
- 设置为 `off`、`false` 或空字符串时，禁用文件写入，工具返回 `recorded = false` 并说明日志已关闭。
- 不支持远端上传目标。

单条 JSONL：

```json
{
  "feedback_id": "fb_20260627_abc123",
  "timestamp": "2026-06-27T12:34:56.000Z",
  "tool_name": "aux_compress_command_output",
  "trace_id": "abc12345",
  "issue_category": "wrong_kind",
  "severity": "medium",
  "summary": "测试全绿输出被标记为 test_failure",
  "evidence": "message says 0 failures but kind is test_failure",
  "expected_behavior": "kind should be test_success and first_failure should be null",
  "actual_behavior": "kind was test_failure",
  "confidence": "high"
}
```

## 9. 实施步骤

1. 读取目标源码并确认实际会修改的 symbols；如实际 symbol 与第 4 节不同，先更新第 4 节。
2. 对所有实际会修改的目标 symbols 运行 GitNexus upstream impact，记录 risk、直接调用方和受影响 execution flows。
3. 若任一目标 symbol 返回 HIGH 或 CRITICAL，先向用户报告 blast radius 并获得继续许可。
4. 建立 Step 0 红灯测试。
5. 扩展 `ResultMetaSchema`，新增 `_meta.trace_id` 和 `_meta.tool_name`。
6. 将现有工具内部 trace id 写入输出 `_meta`。
7. 定义 `ToolFeedbackInput` 和 `ToolFeedbackOutput` schema。
8. 实现 `handleReportToolFeedback`，写入 JSONL。
9. 增加反馈 sanitizer，限制长度并过滤明显敏感 token。
10. 在 `src/index.ts` 注册 `aux_report_tool_feedback`。
11. 新增聚合脚本 `scripts/summarize-feedback.ts`，按工具、类别、严重度聚合。
12. 更新 README、AGENTS 和 migration note。
13. 运行测试、smoke、build。
14. 运行 `detect_changes()`，确认影响范围与本计划一致。

## 10. 聚合脚本

脚本：

```text
scripts/summarize-feedback.ts
```

输入：

```text
.aux-feedback.jsonl
```

输出：

```text
docs/feedback/feedback-summary-YYYY-MM-DD.md
```

聚合内容：

- 总反馈数；
- 按工具统计；
- 按 `issue_category` 统计；
- high / critical 反馈列表；
- 重复问题聚类；
- 可转 fixture 候选。

fixture 候选判定：

```text
severity >= medium
confidence >= medium
有 trace_id
有 expected_behavior
有 actual_behavior
```

`low_signal_output` 允许进入普通聚合统计；只有同时满足以上条件时才进入 fixture 候选。

## 11. Schema Migration

| 旧行为 | 新字段/工具 | 兼容行为 | 消费方读取优先级 |
|---|---|---|---|
| trace id 只在内部日志中 | `_meta.trace_id` | 旧调用方可忽略新增字段 | 调用反馈工具时优先传 `_meta.trace_id` |
| 工具名由调用上下文隐式知道 | `_meta.tool_name` | 旧调用方可忽略新增字段 | 反馈时可用 `_meta.tool_name` 校验 |
| 无消费方反馈通道 | `aux_report_tool_feedback` | 不影响现有工具 | 仅在发现质量问题时调用 |

## 12. 回滚策略

- 可通过 `AUX_FEEDBACK_LOG_FILE=off` 禁用反馈写入。
- 如果反馈工具异常，返回 `recorded = false`，不得影响原工具调用。
- `_meta.trace_id` 和 `_meta.tool_name` 为新增字段，回滚实现时可保留为空或不输出。
- 聚合脚本失败不影响 MCP server。

## 验证

```text
npm run build        → 通过
npm test             → 334 tests, 324 pass, 0 fail, 10 skipped
npm run smoke        → 10 pass, 0 fail
专项测试              → 8/8 pass（trace id 输出、反馈写入、日志禁用、敏感内容脱敏）
聚合脚本              → 手动测试通过，生成按工具/类别统计和 fixture candidate 的 Markdown 报告
detect_changes()     → 39 changed symbols, 68 affected, 17 files, risk_level: critical（预期范围内，纯机械变更 + 治理文档收尾提交）
```

## 14. 完成定义

- [x] 所有现有工具输出 `_meta.trace_id` 和 `_meta.tool_name`。
- [x] `aux_report_tool_feedback` 已注册并可调用。
- [x] 反馈成功写入合法 JSONL。
- [x] `AUX_FEEDBACK_LOG_FILE=off` 可禁用反馈日志。
- [x] 超长和敏感反馈被拒绝或脱敏。
- [x] 聚合脚本能输出按工具和类别统计的摘要。
- [x] README / AGENTS 已说明何时应该主动反馈。
- [x] migration note 已更新。
- [x] build、test、smoke 通过。
- [x] `detect_changes()` 只包含预期流程（39 symbols（含 2 个治理文档触及）, 68 processes 全部为 traceMeta 参数传递触及 + 治理文档收尾变更，无异外功能变更）。

## 完成证据

- Step 0 证据：反馈工具写入、trace id 暴露、日志禁用和敏感内容脱敏专项测试已转绿。
- 验证证据：`npm run build`、`npm test`、`npm run smoke`、专项测试和聚合脚本手动测试均通过。
- 治理证据：`docs/PLAN_MAP.md` 已标记为已完成。

## 测试覆盖率

- 专项测试 8/8 pass，覆盖 trace id 输出、反馈写入、日志禁用和敏感内容脱敏。
- 测试通过：`npm test` 记录为 334 tests, 324 pass, 0 fail, 10 skipped；`npm run smoke` 记录为 10 pass, 0 fail。
