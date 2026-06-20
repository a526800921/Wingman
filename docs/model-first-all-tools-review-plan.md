# Wingman 全工具模型优先评审与重构计划

## 1. 评审目标

本次评审覆盖以下工具：

- `aux_summarize_file`
- `aux_compress_text`
- `aux_review_diff`
- `aux_review_diff_by_file`
- `aux_compress_command_output`，作为已讨论的模型优先基准

核心判断标准：

```text
模型负责理解、归纳、风险判断和语义压缩
本地代码负责安全、结构、预算、证据校验和失败降级
```

本地确定性逻辑不是越少越好，但不能继续演变成针对不同语言、测试框架、构建工具和风险类型的第二套语义引擎。

## 2. 总体结论

当前各工具的模型 handler 基本都已存在，主要偏移集中在两方面：

1. fallback 逻辑承担了过多语义理解；
2. 长输入处理使用前缀截断或过早分片，没有统一为“按最终模型预算决定是否分批”。

现状概览：

| 工具 | 模型主路径 | 本地语义逻辑 | 长输入策略 | 跑偏程度 |
|---|---|---:|---|---:|
| `summarize_file` | 有 | 约 918 行 fallback | 前缀截断 | 高 |
| `compress_text` | 有 | 约 277 行关键词 fallback | 前缀截断 | 中 |
| `review_diff` | 有 | 约 957 行风险规则 fallback | 智能截断但不分批 | 高 |
| `review_diff_by_file` | 有 | 约 236 行风险 fallback | 默认按文件/hunk 分片 | 中 |
| `compress_command_output` | 有 | 多种格式 parser | 已开始模型优先调整 | 重构中 |

最需要纠正的不是“所有本地代码”，而是以下语义适配：

- 多语言符号正则；
- 按关键词生成文本摘要；
- 用安全规则直接生成代码审查结论；
- 为每种 test/build 输出新增 parser；
- 用 heuristic 结果伪装成已经完成的模型分析。

## 3. 应保留的本地职责

### 3.1 全工具公共职责

- 输入 schema 校验；
- 敏感信息清理；
- prompt delimiter 防注入；
- 最大输入和调用预算；
- 最终模型 payload 大小估算；
- JSON/schema 校验；
- evidence 回查；
- 无损聚合；
- 模型失败和重试元数据；
- `complete | partial | incomplete` 状态。

### 3.2 `summarize_file`

- workspace 路径边界；
- 拒绝绝对路径和 path traversal；
- 文件存在性和可读性；
- 二进制检测；
- 文件大小和编码处理。

### 3.3 `review_diff*`

- unified diff 结构解析；
- `a/`、`b/` 和 `/dev/null` 路径规范化；
- 文件、hunk、added/removed/context 行边界；
- binary 文件和 omitted tracking。

这些是确定性格式结构，不属于语义适配，应继续保留。

### 3.4 `compress_command_output`

- 通用错误块和栈帧边界；
- 少量高价值 adapter 作为 fast path、validator 或 fallback；
- 不再以新增专用 parser 作为支持新命令类型的前置条件。

## 4. 当前问题评审

### 4.1 `aux_summarize_file`

#### 当前合理部分

- 模型可用时会调用模型；
- 有 workspace 安全检查；
- 输出经过 schema 校验；
- 模型失败会降级，不向调用方抛出普通模型错误。

#### 跑偏部分

`src/fallback/summarize-file.ts` 通过大量正则识别：

- TypeScript/JavaScript/Python/Rust/Go 的函数和类型；
- import/export；
- Markdown sections；
- test cases 和 covered behaviors；
- 符号角色和文件摘要。

这相当于维护一个弱化版多语言代码理解器。新增语言或语法会继续扩大适配面。

#### 长输入问题

文件超过 `max_chars` 后主要保留前缀。重要定义、结论或测试可能位于文件后部，模型无法看到。

#### 目标方向

- 小文件一次调用模型；
- 大文件按结构或通用区段分批，由模型分段总结后再归并；
- fallback 只返回文件元数据和明确的结构信号；
- 不继续新增语言 regex；
- 模型不可用时返回 `analysis_status: incomplete`。

### 4.2 `aux_compress_text`

#### 当前合理部分

- 模型承担正常压缩路径；
- focus 被作为分析视角传入；
- 模型结果经过 schema 校验；
- fallback 明确标记 pattern matching。

#### 跑偏部分

fallback 使用 ERROR/WARN/SUCCESS 关键词、URL、IP、路径、时间戳和数字评分来模拟文本理解。它可以提供信号，但不能等价于语义压缩。

#### 长输入问题

超过 `max_chars` 后使用前缀截断，容易丢失日志末尾的根因、最终异常和结论。

#### 目标方向

- 小文本一次模型调用；
- 长文本通用分块后模型压缩，再由模型做最终归并；
- fallback 输出 `extracted_signals`，不将关键词拼接结果表示为完成的 summary；
- 模型失败时返回 partial/incomplete。

### 4.3 `aux_review_diff`

#### 当前合理部分

- 小 diff 使用单次模型审查；
- prompt 明确要求非权威、证据和不确定性；
- diff 截断会写入元数据；
- 输出经过 schema 校验。

#### 跑偏部分

`src/fallback/review-diff.ts` 使用大量正则直接判断：

- secrets；
- SQL injection；
- command execution；
- empty catch；
- security disabling flags；
- auth/permission；
- type escape；
- logging；
- 严重级别和风险结论。

这些规则适合产生 `heuristic_signals`，不适合直接产生正式 `possible_risks`。规则缺少上下文，容易形成误报。

#### 长输入问题

当前会尽量保留多个文件和 hunk，但本质仍是截断。被省略的文件不会经过模型审查。

#### 目标方向

- 小 diff 一次模型调用；
- 大 diff 转入共享分批流程，而不是仅截断；
- heuristic 规则只作为模型提示或模型不可用时的 signals；
- 正式 risk 必须由模型给出并通过 diff evidence 验证。

### 4.4 `aux_review_diff_by_file`

#### 当前合理部分

- 文件/hunk 结构切分属于合理的确定性预处理；
- 模型负责实际风险判断；
- 支持多个 findings；
- 有受限并发和 omitted tracking；
- 输出按文件聚合。

#### 跑偏或缺陷部分

- 小型多文件 diff 也会提前产生多个模型调用；
- 模型 file 和 chunk source 没有统一 canonical path；
- `a/`、`b/` 和空 preamble 会产生幽灵文件；
- fallback 仍用风险规则直接产生审查结论；
- `files.length` 会受幽灵条目影响，导致 summary 不准确。

#### 目标方向

- 整个 diff 未超过单次模型预算时，使用一次调用并要求模型按文件输出；
- 超过预算才按 canonical file/hunk 分批；
- 文件身份完全来自本地 canonical path，模型 file 仅用于校验；
- 空 preamble 不创建文件 section；
- heuristic 风险降级为 signals。

## 5. 共享目标架构

```text
Tool-specific input preparation
  → 安全清理
  → 确定性结构提取（只提取格式事实）
  → 构造最终模型 payload
  → 是否超过单次调用预算？
      ├─ 否：一次模型调用
      └─ 是：结构感知或通用分批
  → 模型响应 schema 校验
  → evidence 验证
  → 无损聚合
  → tool-specific output projection
  → 统一状态和元数据
```

建议抽取共享模块：

```text
src/model-runtime/
  types.ts
  execution.ts
  batching.ts
  evidence.ts
  aggregation.ts
  status.ts
```

### 5.1 `execution.ts`

负责：

- 模型可用性；
- 单次/多批调用；
- 受限并发；
- 重试统计；
- 部分失败；
- 调用预算；
- skip/failure reason。

### 5.2 `batching.ts`

负责：

- 根据最终 user message 估算 payload；
- 小输入不分批；
- 超预算才切分；
- batch metadata；
- 不在 tool-specific handler 中复制并发循环。

分块边界由工具提供：

```text
summarize_file      → 文件区段
compress_text       → 段落/日志块
review_diff         → canonical file/hunk
command_output      → 通用信号块
```

### 5.3 `evidence.ts`

统一三种验证结果：

```text
verified
partial
unverified
```

工具可以提供自己的确定性验证器，但验证器只确认证据是否存在，不进行语义判断。

### 5.4 `aggregation.ts`

原则：

- 相似语义不等于同一 finding；
- 只有同一 evidence occurrence 才能删除真正重复；
- 重复模式作为额外分组；
- 未分析 batch 必须保留状态；
- 模型输出不能静默覆盖确定性字段。

## 6. 统一状态和元数据

当前前三个工具使用基础 `ResultMetaSchema`，`review_diff_by_file` 和 `compress_command_output` 又有各自扩展，字段语义不一致。

建议统一：

```ts
type AnalysisStatus = "complete" | "partial" | "incomplete";

interface ModelExecutionMeta {
  model_attempted: boolean;
  model_skip_reason?: string;
  model_failure_reason?: string;
  candidate_batches: number;
  batches_sent: number;
  batches_succeeded: number;
  batches_failed: number;
  batches_omitted_by_budget: number;
  model_calls_attempted: number;
  network_attempts?: number;
  input_truncated: boolean;
  fallback_used: boolean;
}
```

统一 skip reason：

```text
model_not_configured
model_unavailable
explicitly_disabled
deterministic_fast_path
input_empty
```

统一原则：

```text
fallback_used = true
不代表 analysis complete
```

heuristic 只能产生 signals 时，状态应为 partial 或 incomplete。

## 7. Fallback 重新定义

### 7.1 当前问题

当前 fallback 的目标是尽量模拟模型输出 schema，因此容易让调用方误以为已经完成语义分析。

### 7.2 新定义

fallback 只提供：

- 确定性结构事实；
- 原始高信号片段；
- heuristic signals；
- 明确 uncertainty；
- 模型未运行或失败原因。

不得提供：

- 无上下文的确定风险结论；
- 假装完整的自然语言总结；
- 由正则推断出的高置信度语义；
- “0 findings”等同于“没有问题”的表达。

### 7.3 建议输出位置

新增可选字段：

```ts
heuristic_signals?: Array<{
  kind: string;
  location?: string;
  evidence: string;
  confidence: "low" | "medium";
}>;
```

正式 `possible_risks`、`key_facts` 或语义 summary 仍由模型路径产生。

## 8. API 模式

建议所有模型型工具支持统一输入：

```ts
analysis_mode?: "model_first" | "auto" | "deterministic_only";
```

语义：

- `model_first`：模型可用时始终调用；
- `auto`：可靠的确定性 fast path 可以跳过模型；
- `deterministic_only`：不调用模型，明确返回 fallback 状态。

推荐默认值：

```text
summarize_file       → model_first
compress_text        → model_first
review_diff          → model_first
review_diff_by_file  → model_first
compress_command_output → auto 或 model_first，由产品成本目标决定
```

对于已有调用方，新增字段必须为 optional，并保持原输入兼容。

## 9. 分阶段计划

### P0：统一可靠性语义

目标：先解决“模型没运行但结果看起来像完整分析”的问题。

任务：

1. 扩展共享 `ResultMetaSchema`；
2. 所有工具增加 `analysis_status`；
3. 增加 model attempted/skip/failure reason；
4. 明确 fallback 只能产生 partial/incomplete；
5. 非空输入但模型/heuristic 均无结果时增加 uncertainty；
6. 增加统一 mock model client 测试；
7. 不在本阶段删除旧 fallback，以降低兼容风险。

验收：

- 调用方可以区分“无问题”和“没有完成分析”；
- 模型为何没运行可观测；
- 模型部分失败不会被标记 complete。

### P1：共享模型执行层

目标：消除各 handler 内重复的模型调用、重试和分批逻辑。

任务：

1. 实现 `model-runtime/execution.ts`；
2. 实现最终 payload 预算；
3. 实现受限并发和模型调用上限；
4. 实现统一 batch metadata；
5. 实现 evidence 验证接口；
6. 逐个迁移 handler，但保持原公开输出字段。

验收：

- 小输入只调用一次模型；
- 网络重试和逻辑调用分开统计；
- 达到预算后返回 partial，不静默丢失。

### P2：优先修复 review 工具

目标：避免 heuristic 风险规则继续充当正式代码审查器。

任务：

1. `review_diff` 风险正则降级为 `heuristic_signals`；
2. 大 diff 从截断改为共享分批；
3. `review_diff_by_file` 增加 canonical path；
4. 空 preamble 不创建文件；
5. 小型多文件 diff 使用一次模型调用；
6. evidence 必须能定位到 diff added/context 行；
7. 文件数和状态从 canonical files 计算。

验收：

- 两文件 diff 不再产生 5 个文件条目；
- 小 diff 不因文件数产生多次调用；
- heuristic signal 不直接进入正式 risk；
- 模型 evidence 不在 diff 中时降级。

### P3：迁移 summarize 和 compress text

目标：停止扩展语言和关键词适配，并修复前缀截断。

任务：

1. `summarize_file` 大文件按区段模型总结；
2. `compress_text` 长文本按段落/日志块模型压缩；
3. 两者增加最终模型归并阶段；
4. summarize fallback 只保留文件元数据和结构 signals；
5. compress fallback 只保留 extracted signals；
6. 停止新增语言 symbol regex；
7. 对旧 fallback 代码做覆盖率和使用率审计后再删除。

验收：

- 文件或文本尾部的重要信息可以进入结果；
- 模型不可用时不输出伪完整 summary；
- 新语言和新文档类型不需要新增 regex。

### P4：收缩旧 fallback

目标：在真实 fixture 和模型评测稳定后减少维护负担。

任务：

1. 统计每个 fallback 分支的实际使用率；
2. 将有价值的确定性规则保留为 validators/signals；
3. 删除重复的语义归纳代码；
4. README 更新为模型优先行为；
5. 保留 migration note 和输出兼容说明。

## 10. 测试计划

### 10.1 当前覆盖缺口

现有 smoke tests 主要验证 fallback 能返回结构化结果，但缺少：

- summarize/compress/review 的真实模型成功路径测试；
- 部分 batch 失败；
- 模型 skip/failure reason；
- evidence 不存在；
- 大输入分批和最终归并；
- model-first 与 deterministic-only 行为差异。

### 10.2 共享契约测试

每个工具必须覆盖：

```text
模型成功
模型不可用
模型返回非法 JSON
模型 schema 不合法
模型 evidence 不存在
部分 batch 失败
达到调用预算
小输入只调用一次
大输入按预算分批
```

### 10.3 工具真实 fixture

#### summarize file

- 大 TypeScript 文件，关键导出位于文件尾部；
- Markdown 文件，结论位于最后一个 section；
- 测试文件，test cases 分布在前后两部分。

#### compress text

- 根因位于日志末尾；
- 混合中英文日志；
- 长文档 focus 只命中后半段。

#### review diff

- 两文件小 diff；
- 高风险 evidence 位于后部文件；
- 正则表面命中但上下文安全的误报样本。

#### review diff by file

- `a/`、`b/` 路径；
- `/dev/null` 新增/删除文件；
- diff preamble；
- 一个文件多个 hunks；
- 模型返回非 canonical file path。

### 10.4 质量指标

- schema valid rate；
- evidence verification rate；
- recall；
- false positive rate；
- model calls；
- network attempts；
- P50/P95 latency；
- partial/incomplete rate；
- fallback usage rate。

## 11. 兼容性策略

本计划会扩展输出 schema，不能一次性删除现有字段。

建议：

1. 新字段全部 optional 或有默认值；
2. 第一阶段保留原 summary/risk/findings 字段；
3. fallback 结果通过 `analysis_status` 和 `heuristic_signals` 区分；
4. README 明确 heuristic 不代表完整模型分析；
5. 经过一个发布周期后再考虑移除旧语义 fallback。

## 12. GitNexus 检查要求

正式修改前分别对以下入口运行 upstream impact：

- `handleSummarizeFile`
- `handleCompressText`
- `handleReviewDiff`
- `handleReviewDiffByFile`
- `handleCompressCommandOutput`

修改共享 schema、模型 runtime 或工具输出字段前，还需检查：

- `src/index.ts` MCP 工具声明；
- smoke tests；
- 所有读取 `_meta`、summary、risks、files 和 findings 的调用方。

如果影响评级为 HIGH 或 CRITICAL，必须先报告影响范围。完成修改后运行 `gitnexus_detect_changes`。

## 13. 推荐实施顺序

```text
1. 统一 analysis status 和模型执行元数据
2. 建立共享 mock model 测试基础
3. 抽取共享模型执行和 payload 预算
4. 修复 review_diff / review_diff_by_file
5. 修复 summarize_file / compress_text 的长输入路径
6. 收缩旧 fallback
```

原因：

- 状态和测试是后续重构的安全网；
- review fallback 会直接生成风险结论，误报影响最大；
- summarize/compress 的主要风险是信息遗漏和维护成本，可随后处理；
- 删除 fallback 必须最后进行，避免缺少降级路径。

## 14. 完成定义

- [ ] 所有工具由模型承担核心语义任务。
- [ ] 本地规则只产生结构事实、validators 或 heuristic signals。
- [ ] 模型未运行或失败时不会伪装成 complete。
- [ ] 小输入只调用一次模型。
- [ ] 大输入根据最终 payload 预算分批，不依赖人为条目数。
- [ ] 每个正式结论都有可回查 evidence。
- [ ] 无损聚合不会删除独立位置或文件。
- [ ] 路径、文件、hunk 和 omitted 状态使用 canonical identity。
- [ ] 新语言、测试框架或构建工具无需新增专用 parser。
- [ ] 共享契约测试覆盖成功、失败、部分失败和预算场景。
- [ ] 全部测试、build 和 smoke 通过。
- [ ] GitNexus 变更检测只包含预期执行流。
