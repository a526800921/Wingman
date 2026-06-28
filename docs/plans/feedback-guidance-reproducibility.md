# 反馈引导与可复现性增强施工计划

## 元数据

- 文档类型：施工计划
- 状态：已完成 (2026-06-28)
- 负责人：Codex
- 依赖计划：`docs/plans/mcp-tool-feedback-loop.md`
- 相关计划：`docs/unfinished-implementation-priority-plan.md` P0.5
- 公开 schema 变化：是，新增 `aux_report_tool_feedback` 可选输入字段，并新增工具输出 `_meta.feedback_recommended` / `_meta.feedback_reason`
- Migration note：`docs/migrations/model-first-output-schema.md`

## 1. 问题与证据

TranslateBar 消费 Wingman 时已经记录 4 条反馈到旧项目级日志：

```text
/Users/jafish/Documents/work/TranslateBar/.aux-feedback.jsonl
```

反馈内容显示两个问题：

1. `aux_summarize_file` 对 Swift 文件的 fallback 输出低信号，足以说明优化方向，但缺少可直接转 fixture 的输入引用和断言提示。
2. 多个分析工具在返回低质量结果时，没有在 tool description 或输出 `_meta` 中提示调用方应使用 `aux_report_tool_feedback`，反馈链路依赖外部记忆，容易遗漏。

已知反馈样本：

| feedback_id | 工具 | 类别 | 严重度 | 用途 |
|---|---|---|---|---|
| `fb_20260628_4784e1` | `aux_summarize_file` | `low_signal_output` | medium | Swift summarize 低信号样本，需要补充可复现输入 |
| `fb_20260628_5a1436` | `aux_summarize_file` | `missing_context` | high | 低质量输出缺少反馈建议 |
| `fb_20260628_708baa` | `aux_compress_text` | `missing_context` | high | 分析工具描述缺少反馈工具互链 |
| `fb_20260628_e23a9b` | `aux_compress_command_output` | `missing_context` | high | `_meta` 缺少自动反馈建议 |

## 2. 必须保持的不变量

- 反馈工具不调用模型，只做本地 schema 校验和 JSONL 写入。
- 反馈字段不得包含 API key、Authorization header、完整源码、完整 diff 或大段日志。
- 新增字段必须 optional，旧调用方不传这些字段仍可正常写入。
- 反馈默认写入统一用户目录 `~/.wingman/feedback.jsonl`，`AUX_FEEDBACK_LOG_FILE` 仍可覆盖或禁用。
- 分析工具输出仍保持 `is_authoritative: false`。
- 反馈建议字段只表示“建议报告质量问题”，不能被调用方当作业务结论。

## 3. 范围

### 包含

- 为 5 个分析工具的 description 增加 `aux_report_tool_feedback` 交叉引用。
- 在低质量输出场景的 `_meta` 中增加固定反馈建议字段：`feedback_recommended` 和 `feedback_reason`。
- 扩展 `aux_report_tool_feedback` 输入 schema，新增可复现性字段。
- 更新反馈 JSONL 写入和聚合脚本，展示可复现输入和断言提示。
- 补充 migration note、README 和测试。

### 不包含

- 不修复 Swift summarize 的模型优先迁移；该问题归入 `docs/plans/summarize-file-model-first.md`。
- 不自动上传反馈到远端服务。
- 不自动采集完整工具输入或完整工具输出。
- 不改变已有 feedback_id 格式。

## 4. 目标 symbols 与影响分析

修改任何目标 symbol 前必须运行 GitNexus upstream impact。当前 GitNexus 索引已观察到可能落后：`aux_report_tool_feedback` 和 `handleReportToolFeedback` 在索引中未解析到，风险需按 UNKNOWN 记录。

| Symbol | 文件 | 预期修改 | GitNexus risk |
|---|---|---|---|
| `ToolFeedbackInputSchema` | `src/schema.ts` | 新增 optional 可复现性字段和长度/敏感信息限制 | 待运行 |
| `handleReportToolFeedback` | `src/tools/report-tool-feedback.ts` | 写入新增字段 | UNKNOWN（当前索引未找到） |
| `handleSummarizeFile` | `src/tools/summarize-file.ts` | fallback/partial 结果写入反馈建议 `_meta` | 待运行 |
| `handleCompressText` | `src/tools/compress-text.ts` | fallback/partial 结果写入反馈建议 `_meta` | 待运行 |
| `handleCompressCommandOutput` | `src/tools/compress-command-output.ts` | partial/fallback/model failure 场景写入反馈建议 `_meta` | 待运行 |
| `handleReviewDiff` | `src/tools/review-diff.ts` | fallback/partial 结果写入反馈建议 `_meta` | 待运行 |
| `handleReviewDiffByFile` | `src/tools/review-diff-by-file.ts` | fallback/partial 结果写入反馈建议 `_meta` | 待运行 |
| `parseArgs` / `renderReport` | `scripts/summarize-feedback.ts` | 聚合报告展示新字段 | 待运行 |

## 4.1 已确认实施决策

### `_meta` 字段名

统一使用：

```json
{
  "feedback_recommended": true,
  "feedback_reason": "fallback_used"
}
```

不得使用 `suggested_feedback` 等别名，避免调用方需要兼容多个字段。

### `feedback_reason` 枚举

第一阶段只允许以下值：

```text
fallback_used
partial_analysis
low_confidence
model_failure
evidence_rejected
```

多个原因同时存在时，按上表顺序选择最主要原因。后续如需多原因数组，另开 schema migration。

### `output_meta` 白名单

`output_meta` 不允许任意 object。第一阶段只允许以下低风险字段：

```json
{
  "analysis_status": "partial",
  "fallback_used": true,
  "confidence": "low",
  "model_attempted": false,
  "model_response_status": "transport_failure"
}
```

字段必须都是 optional；不得写入完整输出、完整输入、源码、diff、命令输出、token 或 header。

### 工具 description 范围

本计划一次性更新全部 5 个分析工具的 description：

```text
aux_summarize_file
aux_compress_text
aux_compress_command_output
aux_review_diff
aux_review_diff_by_file
```

每个 description 都必须提示：当输出为 partial、fallback、low confidence 或证据不足时，调用方应使用 `aux_report_tool_feedback` 报告质量问题。

## 5. Step 0：先建立红灯测试

### Fixture A：反馈 schema 可复现字段

- 输入：调用 `aux_report_tool_feedback`，传入 `repro_input_ref`、`assertion_hint`、`project_context`、`output_meta`。
- 预期：schema 接受输入，JSONL 包含这些字段。
- 红灯原因：旧 schema 不支持这些字段，写入时会丢失。

### Fixture B：低质量输出建议反馈

- 输入：模型不可用时调用 `aux_summarize_file` 或 `aux_compress_text`。
- 预期：输出 `_meta.feedback_recommended === true`，并包含简短 reason，例如 `fallback_used` 或 `partial_analysis`。
- 红灯原因：旧输出只有 `fallback_used`、`analysis_status` 等诊断字段，没有处方型反馈建议。

### Fixture C：工具描述互链

- 输入：读取 `tools/list` 中 5 个分析工具的 description。
- 预期：每个分析工具 description 都提到低质量输出时可调用 `aux_report_tool_feedback`。
- 红灯原因：旧 description 和反馈工具缺少互链。

### Fixture D：聚合报告展示可复现信息

- 输入：包含 `repro_input_ref` 和 `assertion_hint` 的 JSONL。
- 预期：`scripts/summarize-feedback.ts` 生成的 fixture candidates 展示输入引用和断言提示。
- 红灯原因：旧报告只展示 summary、expected、actual 等字段。

## 6. 目标数据流

```text
分析工具输出低质量状态
  → _meta.feedback_recommended = true
  → 调用方看到建议后调用 aux_report_tool_feedback
  → 反馈输入携带 repro_input_ref / assertion_hint / project_context / output_meta
  → ~/.wingman/feedback.jsonl 追加 JSONL
  → summarize-feedback 聚合为 fixture candidates
  → 后续计划转为回归 fixture 或实现任务
```

## 7. 实施步骤

1. 对目标 symbols 运行 GitNexus upstream impact，并记录 UNKNOWN 索引缺口。
2. 增加 Step 0 红灯测试：
   - schema 新字段；
   - fallback/partial 输出反馈建议；
   - tool description 互链；
   - 聚合报告展示可复现字段。
3. 扩展 `ToolFeedbackInputSchema` 和相关类型，新增 optional 字段：
   - `repro_input_ref`；
   - `assertion_hint`；
   - `project_context`；
   - `output_meta`，仅允许已确认白名单字段。
4. 更新 `handleReportToolFeedback`，仅在字段存在时写入 JSONL。
5. 定义共享 `_meta` 反馈建议字段形态：

```json
{
  "feedback_recommended": true,
  "feedback_reason": "fallback_used"
}
```

6. 在 5 个分析工具的低质量路径设置该字段。
7. 更新 `src/index.ts` 中 5 个分析工具 description，加入反馈工具交叉引用。
8. 更新 `scripts/summarize-feedback.ts`，在 fixture candidates 中展示 `repro_input_ref`、`assertion_hint`、`project_context`。
9. 更新 README 和 migration note。
10. 运行验证并记录结果。

## 8. Schema Migration

新增字段均为 optional：

| 字段 | 类型 | 兼容行为 | 消费方读取优先级 |
|---|---|---|---|
| `repro_input_ref` | string | 旧调用方不传不受影响 | 有则优先用于生成 fixture |
| `assertion_hint` | string | 旧调用方不传不受影响 | 有则优先用于测试断言草稿 |
| `project_context` | string | 旧调用方不传不受影响 | 用于按消费项目聚类 |
| `output_meta` | 白名单 object | 旧调用方不传不受影响 | 仅保存低风险元数据摘要 |
| `_meta.feedback_recommended` | boolean | 旧调用方忽略不受影响 | 调用方模型可据此决定是否反馈 |
| `_meta.feedback_reason` | enum string | 旧调用方忽略不受影响 | 用于解释触发原因 |

禁止把完整源码、完整 diff、完整命令输出或凭据写入这些字段。

## 9. 回滚策略

- 新增输入字段都是 optional，可保留 schema 兼容。
- 如 `_meta.feedback_recommended` 触发过多噪声，可先只在 fallback/partial 场景启用。
- 如 `output_meta` 风险过高，可暂时仅允许字符串白名单字段，或从 schema 中去掉。
- 聚合脚本展示逻辑可独立回滚，不影响反馈写入。

## 10. 验证

```bash
node --import tsx --test test/mcp-tool-feedback-loop.test.ts
npm test
npm run build
npm run smoke
```

GitNexus：

```text
detect_changes()
```

如果 GitNexus 仍无法识别新增反馈工具 symbols，需要在完成证据中记录索引缺口和实际测试覆盖。

## 11. 完成定义

- [ ] Step 0 红灯测试已确认并转绿。
- [ ] `aux_report_tool_feedback` 支持可复现性字段。
- [ ] 低质量分析输出包含反馈建议 `_meta`。
- [ ] 5 个分析工具 description 与反馈工具互链。
- [ ] 聚合报告显示 `repro_input_ref` 和 `assertion_hint`。
- [ ] README 和 migration note 已更新。
- [ ] `npm test`、`npm run build`、`npm run smoke` 通过。
- [ ] `detect_changes` 结果已记录，索引缺口已说明。
- [ ] `docs/PLAN_MAP.md` 或上位优先级计划状态已同步。
