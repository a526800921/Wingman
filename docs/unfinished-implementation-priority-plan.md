# 未完成项优先级实施计划

## 背景

本计划基于 `docs/PLAN_MAP.md`、现有专项计划和验收复核文档整理，用于给未完成工作排序。排序原则是：

1. 先修复已经标记完成但证据不闭合的风险；
2. 再统一公共契约和共享执行层；
3. 最后推进下游工具迁移和发布。

进入任何实施阶段前，必须遵守计划治理门禁：补齐 Step 0 证据、运行目标 symbol 的 GitNexus upstream impact、明确验证方式，并在完成时记录验证结果和 `detect_changes` 结果。

## 总体顺序

```text
1. TranslateBar 验收补齐或撤回完成状态
2. 反馈引导与可复现性增强
3. analysis_status 与 schema migration 语义统一
4. shared model-runtime 与 mock model 测试
5. review_diff / review_diff_by_file 收敛
6. summarize_file 模型优先迁移
7. compress_text 模型优先迁移
8. npm publish
```

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

这是反馈闭环的小型前置任务。TranslateBar 中已有反馈说明，目前反馈内容足以排序和写计划，但还不完全足以自动转为回归 fixture。尤其是 Swift summarize 低质量反馈缺少可复现输入定位和断言提示。

### 实施范围

- 给 5 个分析工具的 description 增加 `aux_report_tool_feedback` 交叉引用。
- 在输出 `_meta` 中增加反馈建议字段，例如 `feedback_recommended: true` 或 `suggested_feedback: true`。
- 触发条件包括：
  - `fallback_used === true`；
  - `analysis_status !== "complete"`；
  - `confidence === "low"`；
  - 模型响应失败；
  - evidence 校验拒绝了关键 finding。
- 扩展 `aux_report_tool_feedback` 输入 schema，新增可选字段：
  - `repro_input_ref`：文件路径、fixture 名、命令标签或其他可复现输入引用；
  - `assertion_hint`：希望回归测试断言什么；
  - `project_context`：消费项目名，例如 `TranslateBar`；
  - `output_meta`：低风险 `_meta` 摘要，例如 `analysis_status`、`fallback_used`、`confidence`、`model_attempted`。
- 更新反馈日志聚合脚本，在 fixture candidates 中优先展示 `repro_input_ref` 和 `assertion_hint`。
- 将已有 TranslateBar 反馈迁移或补录到统一用户目录 `~/.wingman/feedback.jsonl` 时，尽量补充 `project_context`。

### Step 0 证据

- 使用 TranslateBar 旧反馈作为样本：
  - `fb_20260628_4784e1`：Swift summarize 低信号输出，需要补可复现输入引用；
  - `fb_20260628_5a1436`、`fb_20260628_708baa`、`fb_20260628_e23a9b`：工具缺少反馈引导。
- 新增测试确认低质量输出会设置反馈建议字段。
- 新增 schema 测试确认新可选字段可写入 JSONL，且仍受长度和敏感信息限制。

### 完成门禁

- fallback / partial / low confidence 场景返回反馈建议字段。
- tool descriptions 能让调用方只看分析工具描述就发现反馈链路。
- `aux_report_tool_feedback` 支持新增可复现性字段。
- 聚合报告能展示 fixture candidates 的输入引用和断言提示。
- `npm test`、`npm run build`、`npm run smoke`、`detect_changes` 通过。

## P1：统一 analysis status 与 schema migration 语义

这是所有模型优先迁移的公共契约底座。若不先统一，`summarize_file`、`compress_text` 和 review 工具会继续各自定义状态语义，造成后续漂移。

### 实施范围

- 移除或收紧 `AnalysisStatusSchema.default("complete")`。
- 要求所有 handler 显式设置 `complete | partial | incomplete`。
- 明确顶层 `analysis_status` 与 `_meta.analysis_status` 的读取优先级。
- 统一 `ResultMetaSchema` 与各工具自定义 `_meta`。
- 同步 `src/schema.ts` 与 `src/index.ts` MCP JSON schema。
- 补充旧 payload 兼容 fixture。

### 完成门禁

- 模型成功、截断、部分失败、完全失败状态分别有测试。
- fallback 路径显式返回 `partial` 或 `incomplete`。
- README 和 tool description 不暗示 heuristic 等同完整分析。
- `npm test`、`npm run build`、`npm run smoke` 通过。

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

## P6：npm publish

最后执行。npm 发布不会改变 MCP 行为，但会放大前面所有契约问题。应等 P0-P3 至少稳定后再发布；若目标是质量发布，最好等 P4/P5 也完成。

### 实施范围

- `package.json` 添加 scoped package name、`bin`、`files` 和 `prepublishOnly`。
- README 增加 npx 安装方式，同时保留本地 build 方式。
- 使用 `npm pack --dry-run` 验证发布内容。
- 手动执行 `npm publish`。

### 完成门禁

```bash
npm pack --dry-run
npm test
npm run build
npm run smoke
node dist/index.js </dev/null
```

发布后验证：

```bash
npx -y @jafish/wingman-mcp </dev/null
```

## 当前工作区前置处理

进入 P0 实施前，建议先处理当前未提交文档变更，避免治理规范和功能修复混在一起：

- `AGENTS.md` 已从 Git 跟踪中移除，本地文件保留；
- `docs/PLAN_MAP.md` 有计划治理规范更新；
- `docs/PLAN_TEMPLATE.md` 有计划模板更新。

建议先单独提交或明确丢弃这些治理文档变更，再开始功能修复。
