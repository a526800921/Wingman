# Phase 2 新工具修复方案

## 1. 背景

根据 `aux_compress_command_output` 和 `aux_review_diff_by_file` 的真实使用报告，当前实现已具备基础实用价值，但在诊断边界识别、结果聚合、噪声排序、模型调用次数和多风险召回方面存在明显缺陷。

本方案优先修复正确性与结果一致性，再优化延迟和输出可用性。

## 2. 修复目标

1. TypeScript 原始错误数与最终 finding 数保持稳定，不再把 detail 行识别成独立错误。
2. fallback 与模型结果使用同一套聚合口径，避免 summary、findings、repeated errors 和建议互相矛盾。
3. 项目源码错误优先于生成文件、依赖文件和低置信度噪声。
4. 确定性 parser 可以独立产出完整结果；仅在需要语义增强时批量调用模型，且一个响应可以返回多个 finding。
5. `aux_review_diff_by_file` 返回完整的逐文件结果，而不是仅返回 `top_risks`。
6. 元数据准确反映实际分析、失败、省略和截断情况。

## 3. 已确认问题

### 3.1 TypeScript diagnostic 被拆散

`chunkTscErrors` 当前只匹配错误首行，两个错误首行之间的缩进 detail 会被单独放入 `tsc context` chunk。

结果是 14 个真实错误生成 23 个 chunk，并可能产出超过 14 条 finding。

修复原则：以“错误首行 + 后续 detail 行”为一个完整 diagnostic，而不是按单行切分。

### 3.2 fallback 与模型输出口径不一致

当前模型成功后只替换 `findings`，以下字段仍来自 fallback：

- `summary`
- `first_failure`
- `repeated_errors`
- `suggested_source_checks`
- `suggested_next_commands`

因此模型 findings 的数量和内容可能与其他派生字段不一致。

修复原则：先形成统一的最终 findings，再从最终结果重新计算所有派生字段。

### 3.3 每个 chunk 只能返回一个 finding

两个工具的模型 prompt 都限制为单 finding 输出。这会造成：

- command output 无法有效批量发送多个 diagnostic；
- 一个 diff chunk 包含多个风险时只能召回一个；
- 为保证召回率被迫增加 chunk 和网络调用数量。

修复原则：模型输出改为 `findings: []`，并限制单次最大 finding 数量。

### 3.4 建议列表未区分可操作性

`suggested_source_checks` 当前直接取前五条带文件路径的 finding。生成目录中的错误可能占满列表，真正需要修改的项目源码反而被遗漏。

修复原则：保留生成文件诊断，但降低其行动优先级，不直接静默丢弃。

### 3.5 模型请求串行执行

两个 handler 都逐 chunk 串行调用远程模型。chunk 数量过多时，网络往返时间线性累积。

修复原则：首先跳过不需要模型增强的 diagnostic，其次将剩余 diagnostic 批量发送；仍需多请求时才使用受限并发。

### 3.6 `review_diff_by_file.files` 在模型路径为空

模型路径目前固定返回 `files: []`，调用方无法区分“文件已审查且无问题”和“文件未被分析”。

修复原则：按文件聚合每个 chunk 的结果，并保留文件级分析状态。

## 4. 目标设计

### 4.1 统一 finding 流水线

```text
原始输入
  -> 确定性解析
  -> 完整语义块
  -> 判断是否需要模型增强
  -> 对需要增强的语义块批量调用模型（可选）
  -> 合并与校验
  -> 去重、归一化、排序
  -> 重新计算 summary / first failure / repeated errors / checks
  -> 输出
```

对于 tsc、eslint 等格式稳定的输出，确定性解析结果是文件、位置、错误码和诊断边界的事实来源。模型只负责补充分类、解释、置信度和优先级，不应重新创造或拆分诊断。

### 4.2 TypeScript diagnostic 结构

建议内部增加独立结构：

```ts
interface CommandDiagnostic {
  id: string;
  kind: "type_error" | "lint_error" | "test_failure" | "unknown";
  file?: string;
  line?: number;
  column?: number;
  error_code?: string;
  headline: string;
  details: string[];
  evidence: string;
  first_seen_index: number;
  source_kind: "project" | "test" | "generated" | "dependency" | "unknown";
  actionability: "high" | "medium" | "low";
}
```

`source_kind` 只用于排序和展示，不能作为自动忽略错误的依据。

#### 4.2.1 诊断块解析策略

不能仅使用“从一个错误首行截取到下一个错误首行”的宽泛切片方式，否则最后一个错误可能吞入 tsc 汇总、npm 输出或其他构建日志。应使用逐行状态机完成三级识别：

```text
1. 识别 diagnostic 首行
2. 收集 detail、代码片段和 related information
3. 遇到下一个 diagnostic 或明确终止标记时结束当前块
```

基础状态如下：

```text
IDLE
  └─ diagnostic header → IN_DIAGNOSTIC

IN_DIAGNOSTIC
  ├─ detail/code frame/related info → 追加到当前 diagnostic
  ├─ next diagnostic header → 提交当前块并创建新块
  ├─ explicit terminator → 提交当前块并回到 IDLE
  └─ unrelated line → 提交当前块，由 generic parser 处理该行
```

首行至少支持以下格式：

```text
src/app.ts(10,5): error TS2322: ...
src/app.ts:10:5 - error TS2322: ...
error TS5058: ...
```

解析前应清除 ANSI 控制码，但 `evidence` 中的文本内容、路径、错误码和位置必须保持不变。

初始版本可以将以下内容识别为 diagnostic 的延续部分：

- 缩进的类型展开或属性缺失说明；
- pretty 模式的源码行和波浪线指示；
- TypeScript 输出的 related information；
- diagnostic 内部用于排版的空行，但必须设置最大连续空行数；
- 不符合新 diagnostic 首行且没有命中终止条件的短上下文行。

明确终止条件至少包括：

```text
Found N errors
Found N error
Watching for file changes
npm ERR!
pnpm ERR!
下一个 diagnostic 首行
```

为防止异常输入产生超大块，每个 diagnostic 还应设置字符数和行数上限。达到上限时提交当前块，并在 `_meta` 或 `discarded_or_low_confidence` 中记录截断原因。

#### 4.2.2 解析与分块职责

解析和模型分块必须分离：

```text
原始输出
  → 清除 ANSI 控制码
  → parseTscDiagnostics
  → CommandDiagnostic[]
  → 选择需要模型增强的 diagnostics
  → 按字符预算将 4～8 个 diagnostic 组成一个 request batch（可选）
```

`src/chunking/command-output.ts` 和 `src/fallback/compress-command-output.ts` 应复用同一个 diagnostic parser，避免 fallback 认为有 14 个错误，而模型分块认为有 23 个片段。

不应单纯按错误码分组。相同 TS 错误码可能出现在不同文件和位置，并具有不同消息和根因。重复归并属于最终结果聚合阶段，不能替代 diagnostic 边界解析。

#### 4.2.3 覆盖范围与降级行为

仅使用“错误首行 + 缩进行”的简单规则，预计只能覆盖常规 `tsc --noEmit --pretty false` 输出的约 80%～90%，不能作为完整实现的质量承诺。

采用上述三级状态机，并通过真实 fixture 覆盖以下场景后，可以将目标设为覆盖约 95% 的日常 TypeScript 命令输出：

- 普通 `tsc --noEmit`；
- `--pretty` 输出及 ANSI 颜色码；
- `--watch` 多轮编译输出；
- Next.js 生成类型错误；
- monorepo 和 project references；
- Windows 与 POSIX 路径；
- 无文件位置的全局配置错误；
- npm、pnpm、Next.js 或其他构建日志包装后的 tsc 输出；
- 多行 TS2344 等复杂类型展开；
- `Found N errors in M files` 汇总信息。

覆盖率必须以 fixture 和回归测试结果衡量，不应仅依赖人工估计。无法识别的格式应进入 generic fallback，并满足：

- 不伪造文件、行列号或错误码；
- finding 使用 `unknown` 或低置信度分类；
- `_meta` 标记 parser fallback；
- 原始证据经过敏感信息清理后保留；
- 不因单个无法识别的区段丢失其他已成功解析的 diagnostics。

### 4.3 批处理策略

- 首先按完整 diagnostic 解析。
- 确定性结果已经足够时直接返回，不创建模型 batch。
- 仅对需要增强的 diagnostics 分批，每批约 4～8 个，同时受字符上限约束。
- 不按错误码单独分组；相同错误码可能对应不同位置和根因。
- 只有形成多个模型 batch 时才使用 2～4 的受限并发。
- 模型调用上限必须在 `_meta` 中体现为 omitted，而不是静默截断。

#### 4.3.1 chunk 与模型调用解耦

当前实现近似于“一个语义片段产生一次模型调用”：

```text
原始输出
  → chunkCommandOutput
  → N 个 chunks
  → N 次串行模型调用
  → 聚合 findings
```

当每次调用还包含重试时，实际网络请求数可能进一步放大。真实报告中 14 个错误产生 23 个 chunk，说明语义切分粒度已经直接转化为明显的调用成本和延迟。

修复后必须明确区分三个层次：

```text
原始日志
  → Diagnostic blocks：保证每个错误语义完整
  → Request batches：按字符预算合并多个 diagnostics
  → Model calls：仅对需要增强的 batches 发起调用
```

三者不能使用同一个数量指标。diagnostic 数量可以很多，但 request batch 和模型调用数量必须受到独立预算控制。

#### 4.3.2 模型调用条件

对 tsc、eslint 等格式稳定的输出，确定性 parser 已能可靠提取文件、位置、错误码和消息，因此默认不应逐条调用模型。

以下情况可以跳过模型：

- parser 置信度为 high；
- diagnostic 格式完整且字段齐全；
- 用户只需要结构化错误列表；
- 错误可以通过确定性规则完成去重和排序；
- 命令成功且没有 actionable findings。

以下情况才需要模型增强：

- 输出格式未知或混合了多种工具日志；
- parser 置信度为 low/medium；
- 需要语义归因、复杂重复模式归一化或行动优先级判断；
- 用户通过 `focus` 明确要求额外分析；
- 同一 diagnostic 存在难以通过规则解释的复杂上下文。

模型是可选增强层，不是基础结构化结果的唯一来源。模型不可用、超时或达到预算时，工具仍必须返回完整的 parser 结果。

#### 4.3.3 调用预算与降级

建议为一次工具调用设置独立预算：

```text
batch_size:       默认 4～8 个 diagnostics
max_model_calls:  默认 5
model_concurrency: 默认 2，最大 4
```

具体数值应通过真实日志基准测试调整，并同时受单批字符数或 token 预算限制。

以报告中的 14 个 tsc 错误为例，目标行为应为：

```text
仅结构化：       0 次模型调用
需要语义增强：   2～4 次模型调用
禁止出现：       14～23 次逐片调用
```

达到 `max_model_calls` 后：

- 未发送部分继续保留确定性 parser 结果；
- 不得静默丢失 findings；
- `_meta` 记录候选 batch 数、实际模型调用数、成功数、失败数和预算省略数；
- `discarded_or_low_confidence` 说明哪些内容没有经过模型增强；
- summary 明确区分“已解析”和“已由模型增强”的范围。

建议 `_meta` 增加：

```json
{
  "diagnostics_parsed": 14,
  "candidate_batches": 3,
  "model_calls_attempted": 3,
  "model_calls_succeeded": 3,
  "model_calls_failed": 0,
  "batches_omitted_by_budget": 0,
  "model_enhanced_diagnostics": 14
}
```

重试次数应单独记录，不能把一次逻辑模型调用的多次网络尝试混入 `analyzed_chunks`。这样才能准确判断延迟来自分块、模型失败还是重试策略。

### 4.4 模型输出格式

command output：

```json
{
  "findings": [
    {
      "diagnostic_id": "tsc-3",
      "kind": "type_error",
      "message": "...",
      "confidence": "high",
      "actionability": "high"
    }
  ]
}
```

diff review：

```json
{
  "findings": [
    {
      "risk": "...",
      "severity": "medium",
      "file": "src/example.ts",
      "evidence": "...",
      "confidence": "medium"
    }
  ]
}
```

模型结果必须通过 schema 校验。无法映射到输入 diagnostic 的结果应进入 `discarded_or_low_confidence`，不能直接进入正式 findings。

### 4.5 排序规则

command output 建议依次考虑：

1. 是否可操作；
2. `source_kind`：project、test、generated、dependency；
3. 错误优先于 warning；
4. confidence；
5. 原始出现顺序。

同时保留：

- `first_failure`：原始输出中的第一个失败；
- `primary_actionable_failure`：最值得优先处理的失败。

两者语义不能混用。

## 5. 实施任务

### P0：正确性

#### 任务 1：解析完整 diagnostic

涉及文件：

- `src/chunking/command-output.ts`
- `src/fallback/compress-command-output.ts`
- `test/chunking-command-output.test.ts`
- `test/compress-command-output.test.ts`

验收标准：

- 14 个 TypeScript 错误解析为 14 个 diagnostic。
- 缩进 detail 属于前一个 diagnostic。
- evidence 保留完整诊断块。
- 不同换行符和 Windows 路径均可解析。

#### 任务 2：统一最终结果聚合

涉及文件：

- `src/tools/compress-command-output.ts`
- `src/fallback/compress-command-output.ts`
- `src/chunking/merge.ts`

验收标准：

- 所有派生字段均基于最终 findings 计算。
- findings 数量与 summary 计数一致。
- 部分模型请求失败时，确定性解析结果仍完整保留。
- 模型不得覆盖文件、行列号和错误码等确定性字段。

#### 任务 3：模型 schema 支持 findings 数组

涉及文件：

- `src/prompts.ts`
- `src/schema.ts`
- `src/tools/compress-command-output.ts`
- `src/tools/review-diff-by-file.ts`

验收标准：

- 单个响应可以返回零到多个 findings。
- 非法条目被隔离，不导致整批有效结果丢失。
- 同一个 diff chunk 中的两个独立风险均可返回。

### P1：延迟与可用性

#### 任务 4：模型调用筛选、批处理与受限并发

涉及文件：

- `src/chunking/command-output.ts`
- `src/tools/compress-command-output.ts`
- `src/tools/review-diff-by-file.ts`

验收标准：

- 14 个高置信度、仅需结构化的 tsc diagnostic 使用 0 次模型调用。
- 14 个需要语义增强的短 diagnostic 使用 2～4 次模型调用，且不超过 `max_model_calls`。
- 并发数可配置且默认不超过 4。
- 单批失败不影响其他批次。
- `_meta` 分别记录 diagnostic、batch、逻辑模型调用、网络重试和预算省略数量。

#### 任务 5：可操作性分类和建议排序

涉及文件：

- `src/fallback/compress-command-output.ts`
- `src/schema.ts`
- `src/tools/compress-command-output.ts`

验收标准：

- 项目源码错误优先进入 `suggested_source_checks`。
- `.next` 等生成文件仍保留在输出中，但标记为 generated/low。
- 生成目录模式可配置。
- 建议按文件去重，避免同一文件占满列表。

#### 任务 6：补全 diff 文件级聚合

涉及文件：

- `src/tools/review-diff-by-file.ts`
- `src/fallback/review-diff-by-file.ts`
- `src/chunking/merge.ts`

验收标准：

- `files` 包含每个已分析文件。
- 每个文件包含 findings 和分析状态。
- 无风险、失败、截断和省略状态可以区分。
- `top_risks` 从文件级结果统一聚合生成。

### P2：产品行为

#### 任务 7：自动选择 diff 审查策略

- 小 diff 使用整体审查。
- 多文件或超出字符阈值时使用按文件审查。
- hunk 被截断时降低全局控制流结论的 confidence。
- 高风险结论可提示调用方回查源码。

该任务不阻塞 P0/P1，可在核心正确性稳定后实施。

## 6. 回归测试矩阵

| 场景 | 核心断言 |
|---|---|
| 多行 TS2344 | 主消息和 detail 合并为一个 finding |
| 14 个真实 tsc 错误 | 最终保持 14 条，不出现 14→20 |
| 多个相同 TS 错误 | repeated errors 正确计数，同时保留各位置 |
| `.next` + 项目源码混合 | 项目源码优先进入 actionable checks |
| Windows/POSIX 路径 | 文件、行、列解析一致 |
| 模型全部失败 | 完整返回 fallback 结果 |
| 模型部分失败 | 成功批次增强，失败批次保留 fallback |
| 高置信度 tsc 仅结构化 | 返回完整结果且模型调用数为 0 |
| 14 个错误需要模型增强 | 合并为 2～4 个 batch，不逐错误调用 |
| 单 diff chunk 两个风险 | 两个风险均被返回 |
| 多文件 diff | `files` 非空且逐文件状态完整 |
| 超过调用上限 | parser findings 完整保留，`_meta` 明确记录未增强 batch |
| 模型调用发生重试 | 逻辑调用数与网络尝试数分开统计 |
| 干净测试输出 | findings 为空，summary 与 exit code 一致 |

测试数据应优先使用匿名化后的真实命令输出，同时保留少量合成数据覆盖边界条件。

## 7. GitNexus 影响范围

当前图谱显示：

- `handleCompressCommandOutput` 和 `handleReviewDiffByFile` 均由 MCP 路由入口直接调用。
- `chunkDiff` 同时被模型 handler、fallback 和测试使用，修改时必须保持两条执行路径一致。
- `chunkCommandOutput` 的上游影响评级为 LOW，直接影响主要集中在对应测试；图谱对 handler 内部嵌套函数调用的识别不完整，因此仍需以源码和测试结果为准。

正式修改任何函数前，仍需按仓库约定对目标符号重新运行 GitNexus impact 分析。

## 8. 完成定义

满足以下条件后可认为修复完成：

1. 真实报告中的 14→20、23 chunks 和建议被生成文件占满的问题均有自动化回归测试。
2. 两个模型 prompt 均支持多 finding 输出。
3. fallback、模型增强和最终聚合字段不存在计数或语义冲突。
4. command output 在确定性解析足够时不调用模型；需要增强时按 batch 调用，并有可验证的调用预算与重试元数据。
5. `review_diff_by_file.files` 在模型路径下返回完整数据。
6. 全部单元测试、类型检查和 smoke test 通过。
7. 提交前运行 `gitnexus_detect_changes`，确认只影响预期执行流。
