# TranslateBar 报告驱动的 MCP 输出可信度修复计划

## 元数据

- 文档类型：施工计划
- 状态：已完成（2026-06-28）
- 负责人：待定
- 依赖计划：
  - `docs/plans/command-output-response-contract-recovery.md`
- 后续受约束计划：
  - `docs/plans/summarize-file-model-first.md`
  - `docs/plans/review-tools-consolidation.md`
- 相关 ADR：`docs/adr/0001-model-first.md`
- 公开 schema 变化：是，扩展现有 `kind` 枚举并新增 optional 状态、来源字段；旧字段保留一个迁移周期
- Migration note：`docs/migrations/model-first-output-schema.md`
- 触发证据：`/Users/jafish/Documents/work/TranslateBar/docs/wingman-mcp-test-report.md`

## 1. 问题与证据

2026-06-27 的 TranslateBar 真实项目报告显示，全部 Wingman MCP 工具链路可连通，但输出存在三类不能交给下游自动化直接信任的问题：

1. `aux_compress_command_output` 将 xcodebuild 全绿输出分类为 `test_failure`。报告样本显示 136 个测试全部通过、0 failures，但结构化结果中 `first_failure.kind` 为 `test_failure`，且内部标记 `kind_mismatch: true`。
2. `aux_summarize_file` 在 Swift 文件上走 heuristic fallback，多个 `func name(label: Type)` 的参数被显示为 `0 parameters`。这会把不确定的结构扫描伪装成精确 symbol 解析。
3. `aux_review_diff` 未注入当前日期，本地模型把报告日期 `2026-06-27` 误判为未来日期，产生中置信度虚假风险。

该计划不是替代已有模型优先迁移计划，而是把真实项目报告中的红灯样本固化为当前实施门禁。它只依赖已完成的 command-output 响应契约恢复；`summarize-file-model-first` 和 `review-tools-consolidation` 是后续受约束计划，不是本计划的前置依赖。

## 2. 必须保持的不变量

- MCP 工具输出仍为辅助信号，不能标记为权威结论。
- 成功测试输出不能被路由为失败；失败输出不能因新增 success kind 被吞掉。
- fallback 只能表达低置信度结构信号，不得伪装成跨语言 AST 或语义解析。
- “未来日期”类 finding 必须能被运行时当前日期校验；其他日期类 finding 不得被机械后处理误删。
- 新增字段必须 optional，并保持旧调用方一个迁移周期内可继续读取旧字段。
- 修改任何函数、类或方法前必须按 `AGENTS.md` 对目标 symbol 运行 GitNexus upstream impact；HIGH 或 CRITICAL 风险必须先报告。
- 提交前必须运行 `detect_changes()`，确认只影响预期 symbol 和 execution flows。

## 3. 范围

### 包含

- 为 TranslateBar 报告中的三类问题建立 Step 0 红灯 fixtures。
- 修复 `aux_compress_command_output` 的成功/失败分类语义。
- 修复 `aux_summarize_file` 对 Swift/非 TSJS 文件的误导性参数数量输出。
- 为 `aux_review_diff` 和 `aux_review_diff_by_file` 注入当前日期并增加日期类 finding 后处理校验。
- 统一相关工具的输出来源、模型调用和 fallback 诊断字段。
- 更新 schema、migration note、README 中已经实现且验证过的部分。

### 不包含

- 引入 SwiftSyntax、SourceKit 或 tree-sitter-swift。
- 替换本地模型或要求特定模型版本。
- 删除现有 MCP tool name。
- 删除旧输出字段。
- 把 MCP 辅助工具升级为唯一审查依据。

## 4. 目标 symbols 与影响分析

实施前根据当前源码确认目标 symbol 名称。以下为预计修改点，实际以 `context()` 和代码读取结果为准。

本表在计划设计阶段允许保留 `待运行`。进入任何生产代码修改前，必须对所有实际会修改的函数、类或方法运行 GitNexus upstream impact，并把 risk、直接调用方和受影响 execution flows 填回本节。未完成 impact 填表前，不得修改任何生产代码。若任一目标 symbol 返回 HIGH 或 CRITICAL，必须先向用户报告 blast radius 并获得继续许可。

| Symbol | 文件 | 预期修改 | GitNexus risk |
|---|---|---|---|
| `handleCompressCommandOutput` | `src/tools/compress-command-output.ts` | 成功/失败 kind 归一化与输出组装 | 待运行 |
| `modelFirstPath` | `src/tools/compress-command-output.ts` | 模型分类结果校验和 success kind 映射 | 待运行 |
| `fallbackOnlyResult` | `src/tools/compress-command-output.ts` | fallback 成功场景不构造 failure schema | 待运行 |
| `handleSummarizeFile` | `src/tools/summarize-file.ts` | 输出 fallback 诊断字段 | 待运行 |
| `tryModelSummarization` | `src/tools/summarize-file.ts` | 模型路径与 fallback 路径状态统一 | 待运行 |
| `buildFallbackResult` | `src/tools/summarize-file.ts` | 非 TSJS 参数未知语义和低置信度标记 | 待运行 |
| `summarizeFileFallback` | `src/fallback/summarize-file.ts` | Swift 函数参数不再错误确定为 0 | 待运行 |
| `handleReviewDiff` | `src/tools/review-diff.ts` | prompt 当前日期注入和日期 finding 校验 | 待运行 |
| `handleReviewDiffByFile` | `src/tools/review-diff-by-file.ts` | 与 review_diff 保持日期上下文一致 | 待运行 |
| `reviewDiffFallback` | `src/fallback/review-diff.ts` | 日期类 heuristic 降级为 signal | 待运行 |
| `reviewDiffByFileFallback` | `src/fallback/review-diff-by-file.ts` | 日期类 heuristic 降级为 signal | 待运行 |
| `CompressCommandOutputOutput` | `src/schema.ts` | 新增 success kind 与 optional 诊断字段 | 待运行 |

## 5. Step 0：先建立红灯测试

TranslateBar 报告只作为触发证据。Step 0 fixtures 必须存入 Wingman 仓库，并使用脱敏、最小等价样本。测试不得读取 `/Users/jafish/Documents/work/TranslateBar/` 下的外部文件，也不得直接复制 TranslateBar 业务实现。fixture 只保留复现缺陷所需的触发特征。

### Fixture A：xcodebuild 全绿输出

- 输入：TranslateBar 报告中的 xcodebuild 输出，包含 136 tests、0 failures 或等价 `TEST SUCCEEDED` 信号。
- 建议路径：`test/fixtures/command-output/xcodebuild-success-136-tests.txt`。
- 数据策略：保留 `136 tests`、`0 failures`、`TEST SUCCEEDED` 等触发信号，删除项目路径、设备名、用户路径和无关日志。
- Expectation：输出 `kind = "test_success"`；`first_failure` 固定为 `null`；不得出现 `first_failure.kind = "test_failure"`。
- 失败原因：旧实现把成功摘要套进 failure schema。

### Fixture B：Swift 服务类文件

- 输入：`TranslationService.swift`，包含 `translate(text:mode:)`、`makePrompt(text:sourceLang:targetLang:)`、`parseErrorMessage(data:)`、`makeConfiguration() async throws` 等声明。
- 建议路径：`test/fixtures/summarize-file/swift-service-signatures.swift`。
- 数据策略：新建最小 Swift 样本，只构造复现所需的函数签名和少量类型占位，不复制 TranslateBar 业务逻辑。
- Expectation：fallback 路径不得把未知参数数量显示为 `0 parameters`；模型路径必须标记非权威和需源码核验。
- 失败原因：旧 fallback 使用 JS/TS 倾向 regex，参数解析失败后表现为确定的 0。

### Fixture C：当前日期 diff

- 输入：包含 `2026-06-27` 的 diff 或文档变更，运行时当前日期同为 `2026-06-27`。
- 建议路径：`test/fixtures/review-diff/current-date-2026-06-27.diff`。
- 数据策略：新建最小 markdown/json diff，只保留 `2026-06-27` 日期触发点，不引用 TranslateBar 私有内容。
- Expectation：不得产生“该日期是未来日期”的 risk finding。
- 失败原因：旧 prompt 未注入当前日期，模型根据训练时间产生幻觉。

### 红灯确认

```text
运行命令：node --import tsx --test test/translatebar-report-reliability.test.ts
预期失败断言：
- xcodebuild 全绿样本被旧实现标记为 test_failure。
- Swift 参数样本被旧实现显示为 0 parameters。
- 当前日期样本被旧模型路径报告为未来日期。
实际失败结果（2026-06-27）：
- Fixture A (schema): 3 pass — 旧 schema 拒绝 "test_success"/"build_success" kind
- Fixture B (Swift): 1 fail — "init" 显示 "function takes 0 parameters"（实际 2 个参数）
- Fixture C (date):  4 fail — review_diff / review_diff_by_file prompt 不含当前日期
```

未确认以上样本在旧实现上失败，不得开始修改生产代码。

## 6. 目标数据流

```text
MCP 输入
  → 输入 schema 校验
  → 运行上下文注入：当前日期、模型可用性、预算
  → deterministic detector / chunking
  → 模型路径或 heuristic fallback
  → 结果来源与置信度归一化
  → 日期、kind、evidence 等后处理校验
  → optional migration 字段补齐
  → MCP 输出 schema 校验
```

## 7. 实施步骤

1. 读取目标源码并确认实际会修改的 symbols；如实际 symbol 与第 4 节不同，先更新第 4 节。
2. 对所有实际会修改的目标 symbols 运行 GitNexus upstream impact，记录 risk、直接调用方和受影响 execution flows。
3. 若任一目标 symbol 返回 HIGH 或 CRITICAL，先向用户报告 blast radius 并获得继续许可。
4. 固定 Step 0 fixtures，并写出旧实现红灯断言。
5. 确认旧实现红灯后，才开始生产代码修改。
6. 修复 `aux_compress_command_output`：
   - 扩展现有 `kind` 字段，新增 `test_success` 和 `build_success`；
   - 保留既有 `test_failure`、`build_failure`、`generic_log` 语义；
   - 成功场景下 `first_failure` 必须固定为 `null`，不得省略或写入非失败伪对象；
   - `kind_mismatch` 只能作为内部诊断，不得成为正常成功路径。
7. 修复 `aux_summarize_file`：
   - 非 TSJS fallback 输出 `analysis_status = partial`；
   - 增加 `_meta.fallback_used = true`、`analysis_mode = "heuristic_fallback"`、`confidence = "low"`；
   - 参数无法可靠解析时使用 `parameters_unknown` 或 `parameters: null`，不得输出确定的 0；
   - Swift 短期只做防误导处理，不扩展成完整 Swift parser。
8. 修复 review 工具日期语义：
   - prompt 注入运行时当前日期；
   - 仅对“某日期是否为未来日期”这种可机械验证的 finding 做代码侧当前日期校验；
   - 对过期证书、版本窗口、发布时间不一致等依赖业务上下文的日期 finding，不做自动删除，只能按 evidence 和置信度降级；
   - 无 diff evidence 或机械校验不成立的未来日期风险降级为 `heuristic_signals` 或删除。
9. 统一输出诊断字段，采用 `src/schema.ts` 共享契约 + `src/model-runtime/` 统一注入的组合方案：
   - 所有统一诊断字段必须位于 `_meta` 下，不新增同义顶层字段；
   - `src/schema.ts` 扩展现有 `ResultMetaSchema`，作为公开 `_meta` 契约单一来源；
   - 工具特有 `_meta` 字段通过 `.extend()` 扩展共享 schema，例如 `chunking`、`model_response_status`、文件计数等；
   - `src/model-runtime/` 新增或扩展 helper，统一构造 `model_attempted`、`model_used`、`model_skip_reason`、`analysis_mode`、`confidence`、`limitations`；
   - 各工具只传入工具特有上下文，不得各自手写上述 6 个统一字段；
   - `confidence` 表示整体输出可信度，不替代 finding 级 `confidence`。
   统一字段语义：
   - `model_attempted`：是否尝试调用模型；
   - `model_used`：最终输出是否采纳模型结果；
   - `model_skip_reason`：未尝试模型的原因；
   - `analysis_mode`：`"model_analysis" | "heuristic_fallback" | "mixed" | "unsupported"`；
   - `confidence`：`"high" | "medium" | "low"`；
   - `limitations`：调用方必须知道的限制说明。
10. 更新 `src/schema.ts`、`src/index.ts`、migration note 和 README 中已经实现并验证的字段。
11. 重跑 Step 0 fixtures、现有单测、smoke、build。
12. 运行 `detect_changes()`，确认影响范围与本计划一致。
13. 更新本计划验收状态和 `docs/PLAN_MAP.md`。

## 8. Schema Migration

| 旧字段 | 新字段 | 兼容行为 | 消费方读取优先级 |
|---|---|---|---|
| `first_failure.kind = "test_failure"` 成功场景误用 | 扩展现有 `kind = "test_success"` / `"build_success"` | 旧 `first_failure` 字段保留，成功场景固定为 `null` | 先读 `kind`，再读 legacy failure 字段 |
| 隐式 fallback | `_meta.analysis_mode`、`_meta.confidence`、`_meta.limitations` | 旧 summary/findings 字段保留 | 先判断 `_meta.analysis_mode` 和 `_meta.confidence`，再消费正文 |
| `_meta.fallback_used` 工具间语义不一致 | 统一 `_meta` 与模型调用字段 | 不删除旧 `_meta` 字段；共享字段由 `ResultMetaSchema` 定义，工具特有字段用 `.extend()` 扩展 | 优先读 `_meta` 共享字段，再读工具特有字段 |
| 参数数量 `0` 表示解析失败 | `parameters_unknown` 或 `parameters: null` | 旧参数展示字段保留，但不得伪造确定值 | 新调用方优先读 unknown/null 语义 |

`docs/migrations/model-first-output-schema.md` 必须补充 success kind、`_meta.analysis_mode` 和 fallback 可信度的读取建议。

## 9. 回滚策略

- 可回滚的实现开关：模型路径、日期后处理、fallback 降级字段均可通过 optional 字段关闭对外宣称。
- 回滚后保留的 schema：新增 optional 字段可以保留为空或不输出；旧字段继续存在。
- 数据或 fixture 是否需要回滚：fixtures 不回滚，作为防止旧问题复发的回归证据。
- 触发回滚的指标：
  - 真实失败测试被误标为成功；
  - review 日期后处理删除了有 evidence 的真实未来日期风险；
  - summarize_file 对 TS/JS 既有 smoke 测试产生兼容性回归；
  - 模型路径 schema valid rate 明显下降。

## 10. 验证

```text
npm run build
npm test
npm run smoke
专项 fixture：xcodebuild 全绿、Swift 服务类、当前日期 diff
detect_changes()
```

如修改公开 schema，还必须验证：

```text
src/index.ts MCP output schema
src/schema.ts runtime schema
docs/migrations/model-first-output-schema.md
```

## 11. 完成定义

- [x] 三个 Step 0 红灯 fixtures 已确认并转绿。
- [x] 所有目标 symbols 修改前已运行 GitNexus upstream impact。
- [x] HIGH 或 CRITICAL impact 已在实施前报告并获得继续许可。
- [x] 成功测试输出不再返回 `test_failure`。
- [x] 成功测试输出的 `first_failure` 固定为 `null`。
- [x] Swift/非 TSJS fallback 不再输出误导性的确定参数数量。
- [x] 当前日期不再被模型路径报告为未来日期。
- [x] “未来日期”类 finding 有运行时校验；其他日期类 finding 不被机械后处理误删。
- [x] 新增 optional schema 字段已同步 migration note。
- [x] build、test、smoke 通过。
- [x] `detect_changes()` 只包含预期流程。
- [x] `docs/PLAN_MAP.md` 已更新为已完成或下一阶段状态。
