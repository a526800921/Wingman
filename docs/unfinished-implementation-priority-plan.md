# 未完成项优先级实施计划

## 背景

本计划基于 `docs/PLAN_MAP.md`、现有专项计划和验收复核文档整理，用于给未完成工作排序。排序原则是：

1. 先修复已经标记完成但证据不闭合的风险；
2. 再统一公共契约和共享执行层；
3. 最后推进下游工具迁移和发布。

进入任何实施阶段前，必须遵守计划治理门禁：补齐 Step 0 证据、运行目标 symbol 的 GitNexus upstream impact、明确验证方式，并在完成时记录验证结果和 `detect_changes` 结果。

## 总体顺序

```text
1. TranslateBar 验收补齐或撤回完成状态（P0）
2. 反馈引导与可复现性增强（P0.5）
3. shared model-runtime 与 mock model 测试（P2）
4. review_diff / review_diff_by_file 收敛（P3）
5. summarize_file 模型优先迁移（P4）
6. compress_text 模型优先迁移（P5）
```

### 已从未完成队列移出

| 项目 | 专项计划 | 完成时间 |
|---|---|---|
| analysis_status 与 schema migration 语义统一 | `docs/plans/unify-analysis-status.md` | 2026-06-28 |
| npm publish | `docs/plans/npm-publish.md` | 2026-06-28（v0.3.0 已发布） |

## P0：补齐 TranslateBar 验收缺口

优先级最高。`docs/translatebar-report-reliability-acceptance-fix.md` 明确记录当前验收“不通过”，但 `docs/PLAN_MAP.md` 仍将 `docs/plans/wingman-mcp-translatebar-report-reliability.md` 标为已完成。继续推进下游前，需要先让实现、测试、公开 schema、migration note 和治理证据闭合。

### 实施范围

- 修正 `command-output` 成功语义，支持 `test_success` 和 `build_success`。
- 成功场景固定返回 `first_failure: null` 和 `primary_actionable_failure: null`。
- 同步 `src/index.ts` MCP output schema。
- 补充 `docs/migrations/model-first-output-schema.md`。
- 补齐计划中的 GitNexus impact 和 `detect_changes` 证据。
- 如果暂不修复，应先把相关计划状态从“已完成”撤回“实施中”。

### 完成门禁

```bash
node --import tsx --test test/translatebar-report-reliability.test.ts
npm test
npm run build
npm run smoke
```

还必须记录 GitNexus：

```text
detect_changes(scope: "compare", base_ref: "HEAD~1")
```

如果补丁跨多个提交，还应补充覆盖整个计划范围的比较基准。

## P0.5：反馈引导与可复现性增强

专项施工计划：`docs/plans/feedback-guidance-reproducibility.md`

这是反馈闭环的小型前置任务。TranslateBar 反馈已足以排序和写计划，但还不足以自动转为回归 fixture——Swift summarize 低质量反馈缺少可复现输入定位和断言提示，且分析工具缺少反馈链路引导。

实施范围、Step 0 证据、完成门禁与实施步骤详见专项计划。关键契约已确认：

- `_meta` 只使用 `feedback_recommended` 和 `feedback_reason`（固定枚举），不得使用 `suggested_feedback` 等别名。
- `output_meta` 仅允许白名单低风险字段。
- 5 个分析工具 description 一次性更新，与 `aux_report_tool_feedback` 互链。

## P2：完善 shared model-runtime 与 mock model 测试

这是 review、summarize、compress 三条迁移线的共享执行层。先做它可以减少重复修改 handler，并让后续计划共享模型调用、分批、状态和 evidence 校验逻辑。

### 实施范围

- 统一小输入一次模型调用、大输入按预算分批。
- 统一 batch 成功、失败、omitted 和 partial 状态。
- 统一 evidence verification。
- 提供 mock/fake model 注入点，避免测试依赖真实网络。
- 固定模型调用预算测试。

### 完成门禁

- P0 和 P1 的契约测试不回退。
- 新增 runtime 单测。
- 新增跨工具 mock model 测试。
- 模型调用数量、batch 数量和失败状态可稳定断言。

## P3：Review 工具收敛

优先于 summarize/compress。当前 review 工具存在幽灵文件、路径 canonical、heuristic risk 冒充正式 risk 等高误导风险，且会直接复用 P1/P2 的公共能力。

### 实施范围

- 统一 `review_diff` 和 `review_diff_by_file` 的 canonical diff path。
- 小 diff 一次模型调用，超预算才按 file/hunk 分批。
- 正确处理 `a/`、`b/`、`/dev/null` 和空 preamble。
- 文件身份由本地 canonical path 决定，模型返回 file 只用于校验。
- heuristic 规则降级为 `heuristic_signals`。
- 正式 risk 必须有 diff evidence。
- `review_diff_by_file` 入口保留一个兼容周期。

### Step 0 证据

- 两文件 diff，旧实现产生幽灵文件。
- 小型多文件 diff，应只调用一次模型。
- 一个文件多个 hunks。
- `/dev/null` 新增和删除文件。
- 正则表面命中但上下文安全的误报。
- 模型 evidence 不在 diff 中。
- 部分 batch 失败。

### 完成门禁

- 两个真实文件只产生两个 file entries。
- 小型多文件 diff 只有一次模型调用。
- 大 diff 无静默截断。
- heuristic signal 不冒充正式 risk。
- 无 evidence 模型结论被降级。
- by-file 兼容入口仍可用。
- `npm test`、`npm run build`、`npm run smoke`、`detect_changes` 通过。

## P4：迁移 summarize_file

排在 review 后。它的问题主要是 fallback 误导和大文件前缀截断，重要但对安全审查误报的危害低于 review。

### 实施范围

- 大文件分段摘要，保留文件前缀和后缀。
- 模型分段总结后再归并。
- fallback 降级为 structural signals，不再伪装跨语言 parser。
- SwiftUI DSL 误识别降级，不把 `VStack`、`Button`、`ScrollView` 等组件当作高置信度顶层函数。
- 模型路径必须返回 evidence 和 uncertainties。
- 保留旧字段至少一个迁移周期。

### Step 0 证据

- 大源码文件，关键导出位于尾部。
- Markdown 文件，结论位于最后 section。
- 测试文件，test cases 分布在文件前后。
- 模型不可用时 `analysis_status = partial`。
- SwiftUI 文件，确认旧 fallback 会误识别组件调用。
- Swift 服务类文件，确认模型路径能识别语义职责。
- TypeScript 文件，确认 TS fallback 既有结构摘要不被误伤。

### 完成门禁

- 尾部关键结构进入模型摘要。
- 模型不可用时不会返回 `complete`。
- 新语言不需要新增 regex。
- SwiftUI fallback 不再产生高置信误导。
- 新增 optional 字段通过 schema validation。
- 旧调用方字段兼容测试通过。
- 路径穿越与绝对路径测试保持通过。

## P5：迁移 compress_text

排在 summarize 后。它依赖同样的长文本分批和 partial 状态，但 blast radius 更小。

### 实施范围

- 长文本按段落或通用日志块分批。
- 使用模型归并分段摘要。
- 记录未分析和低置信度区段。
- 关键词 fallback 改为 `extracted_signals`。
- 保持旧 `summary`、`key_facts` 字段兼容。

### Step 0 证据

- 根因位于日志末尾。
- focus 只命中文本后半段。
- 混合中英文长文本。
- 一个 batch 失败、其他 batch 成功。
- 模型不可用时 fallback 状态为 `partial`。

### 完成门禁

- 尾部根因进入最终摘要。
- focus 后半段命中不会丢失。
- 小输入一次模型调用。
- 部分失败状态和 omitted 范围可见。
- `npm test`、`npm run build`、`npm run smoke`、`detect_changes` 通过。

## 当前工作区前置处理

进入 P0 实施前，建议先处理当前未提交变更（`src/schema.ts`、`src/tools/report-tool-feedback.ts`、`src/tools/summarize-file.ts`），避免治理规范和功能修复混在一起。建议先单独提交或明确丢弃这些变更，再开始功能修复。
