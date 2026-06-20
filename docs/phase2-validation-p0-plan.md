# Phase 2 前置验证 P0 落地方案

## 1. 目的

本方案只落实当前最值得优先完成的三件事：

1. 建立真实样本回放库；
2. 建立不可违反的契约断言；
3. 建立模型调用预算测试。

目标不是一次建成完整评测平台，而是在最短时间内阻止已经发现过的问题再次出现，并让 chunk、batch 或模型调用数量的异常在 CI 中直接失败。

## 2. 当前基础

仓库已经具备以下基础：

- 使用 Node.js 原生 test runner；
- `npm test` 会执行 `test/*.test.ts`；
- 已有 command output、diff、merge 和 smoke test；
- 已有 `parseTscDiagnostics` 状态机及相关测试；
- 已有 diagnostic batch 和模型调用元数据字段；
- 当前 parser 测试中的大部分样本仍以内联字符串存在；
- 当前没有统一的 `test/fixtures` 真实样本目录和 expectation runner。

因此 P0 不需要引入新的测试框架，优先复用现有 Node test、TypeScript 和 JSON。

## 3. 范围

### 包含

- `aux_compress_command_output` 的真实 tsc 输出回放；
- parser、聚合、排序和模型降级契约；
- 逻辑模型调用、batch 和网络重试预算；
- 一个最小 diff 多风险样本，用于保护 `findings[]` 行为；
- CI 可直接执行的 fixture runner。

### 暂不包含

- 大规模 property-based 测试；
- 真实模型的 recall/误报率评测；
- Shadow 流量；
- 线上样本自动采集；
- 新测试框架或数据库；
- 完整性能压测平台。

这些内容在 P0 稳定后进入 P1/P2。

## 4. 交付物

```text
test/
  fixtures/
    command-output/
      tsc-real-14-errors.txt
      tsc-multiline-ts2344.txt
      tsc-generated-and-source.txt
    diffs/
      multi-risk-single-hunk.diff
    expectations/
      tsc-real-14-errors.json
      tsc-multiline-ts2344.json
      tsc-generated-and-source.json
      multi-risk-single-hunk.json
  helpers/
    fixture-runner.ts
  fixture-replay.test.ts
  command-output-contract.test.ts
  model-call-budget.test.ts
```

如现有 `test/*.test.ts` glob 无法加载子目录 helper，不需要调整 test script；测试文件仍放在 `test/` 根目录，由其导入 `test/helpers/fixture-runner.ts`。

## 5. 任务一：真实样本回放库

### 5.1 首批样本

只加入能保护当前已知问题的最小集合。

#### `tsc-real-14-errors.txt`

来源：真实使用报告中的 14 个错误输入，经匿名化处理。

保护的问题：

- 14 个错误不能产生 20 个 findings；
- 不能产生 23 个模型片段；
- detail 行不能成为独立 finding；
- tsc 汇总不能进入最后一个 diagnostic。

#### `tsc-multiline-ts2344.txt`

保护的问题：

- TS2344 主消息和多层类型展开属于同一 diagnostic；
- evidence 保留完整 detail；
- repeated error 的归一化不破坏具体位置。

#### `tsc-generated-and-source.txt`

同时包含 `.next` 生成文件、项目源码和测试文件错误。

保护的问题：

- 生成文件仍被保留；
- 项目源码优先进入 actionable checks；
- 同一文件不会占满建议列表。

#### `multi-risk-single-hunk.diff`

一个 hunk 内包含两个独立且有证据的风险。

保护的问题：

- 模型/schema 路径支持 `findings[]`；
- 单个 chunk 不再只能返回一个风险；
- 两个 finding 不被错误去重。

### 5.2 匿名化

加入 fixture 前必须：

- 替换真实用户名、绝对目录、仓库地址和内部域名；
- 移除 token、cookie、连接串和业务数据；
- 保留路径格式、缩进、ANSI、换行符、错误码和行列号；
- 人工检查一次 fixture 内容。

### 5.3 Expectation 格式

P0 使用简单 JSON，不设计通用 DSL：

```json
{
  "fixture": "command-output/tsc-real-14-errors.txt",
  "command": "npx tsc --noEmit",
  "exit_code": 2,
  "expected": {
    "diagnostics": 14,
    "findings": 14,
    "must_include_codes": ["TS2344", "TS7053"],
    "must_include_files": ["lib/netease.ts"],
    "must_not_include_evidence": ["Found 14 errors"],
    "max_structure_only_model_calls": 0,
    "max_enrichment_model_calls": 4
  }
}
```

只保存稳定事实，不保存完整 explanation 或 summary 文案。

### 5.4 Fixture runner

`fixture-runner.ts` 只负责：

- 读取 UTF-8 fixture 和 expectation；
- 调用 parser/fallback/handler 测试入口；
- 提供 `assertIncludesCodes`、`assertIncludesFiles` 等小型断言辅助；
- 输出 fixture 名称，便于定位失败；
- 禁止在 runner 中复制生产解析逻辑。

## 6. 任务二：契约断言

### 6.1 Parser 契约

对每个 command output fixture 断言：

```text
diagnostic 数量符合 expectation
每个 diagnostic id 唯一
文件、行、列和错误码来自输入
detail 不生成独立 diagnostic
summary/watch/npm 边界不进入 evidence
解析顺序与原始输入一致
```

### 6.2 Finding 聚合契约

```text
最终 findings 数量与 summary 计数一致
first_failure 是原始第一个失败
primary_actionable_failure 优先项目源码
重复模式保留 count 和不同位置
suggested_source_checks 按文件去重
生成文件被降级但未被删除
```

### 6.3 模型降级契约

使用 fake/mock ChatClient 或抽象的模型调用函数验证：

- 模型不可用：返回完整 parser 结果；
- 全部 batch 失败：返回完整 parser 结果；
- 一个 batch 失败：只有该批缺少增强，基础 findings 不丢失；
- 模型返回非法 JSON：记录失败并降级；
- 模型返回未知 `diagnostic_id`：丢入低置信度/丢弃列表；
- 模型不得覆盖 parser 确定的路径、行列号和错误码。

如果当前 handler 无法注入 fake client，P0 应增加最小依赖注入点，而不是通过真实网络完成这些测试。

### 6.4 Diff 最小契约

通过固定模型响应返回两个 findings，断言：

- 两条均进入结果；
- file 和 evidence 必填；
- 不同风险不会被 deduplicate；
- `files` 中对应文件状态为 analyzed；
- `top_risks` 来自文件级 findings。

## 7. 任务三：模型调用预算

### 7.1 统一计数定义

必须区分：

```text
diagnostics_parsed：parser 识别的诊断数
candidate_batches：符合模型增强条件的 batch 数
batches_sent：实际发出的逻辑模型调用数
batches_succeeded：成功调用数
batches_failed：失败调用数
batches_omitted_by_budget：预算限制未发送数
network_attempts：包含重试的实际 HTTP 尝试数
```

`analyzed_chunks` 不能同时表达以上多个概念。

### 7.2 P0 预算

```text
高置信度、仅结构化的 tsc：0 次模型调用
14 个需要增强的短 diagnostics：2～4 个 batch
单次工具调用逻辑模型调用上限：5
默认并发：2
最大并发：4
```

批大小仍受字符预算约束，不能为了满足调用次数而创建超过模型输入限制的 batch。

### 7.3 必须覆盖的预算测试

#### 场景 A：结构化即可

输入 14 个标准 tsc errors，不提供需要语义分析的 focus。

断言：

```text
diagnostics_parsed = 14
batches_sent = 0
findings = 14
```

#### 场景 B：要求模型增强

输入同一 fixture，并提供需要语义归因的 focus 或显式 enrichment 开关。

断言：

```text
candidate_batches ∈ [2, 4]
batches_sent = candidate_batches
batches_sent <= 5
findings 基础数量仍为 14
```

#### 场景 C：超过预算

输入足够多的 diagnostics，使 candidate batches 超过 5。

断言：

```text
batches_sent = 5
batches_omitted_by_budget > 0
所有 parser findings 仍返回
未增强范围被记录
```

#### 场景 D：重试

fake client 第一次返回可重试错误，第二次成功。

断言：

```text
batches_sent = 1
network_attempts = 2
batches_succeeded = 1
```

逻辑调用数不能因重试错误增加。

## 8. 实施顺序

### Step 1：固定真实输入

1. 从使用报告提取并匿名化 3 个 command output fixture。
2. 新增 1 个 diff fixture。
3. 为每个 fixture 编写 expectation。

完成标准：fixture 可独立阅读，敏感信息检查通过。

### Step 2：实现 fixture runner

1. 增加统一读取函数。
2. 增加最小 expectation 类型。
3. 增加稳定事实断言辅助。

完成标准：一个测试可以通过 fixture 名称完成回放。

### Step 3：先建立失败测试

将已知问题转换为测试，并确认测试确实能在错误实现上失败。不得直接写成只能验证当前实现的“永远通过”测试。

完成标准：每个已知问题至少对应一个明确断言。

### Step 4：补齐模型调用可观测性

1. 统一 batch/call/retry 字段语义。
2. 为 fake model client 增加调用计数。
3. 确保达到预算后无损降级。

完成标准：四个预算场景全部可以确定性测试。

### Step 5：接入现有测试命令

继续使用：

```bash
npm test
npm run build
npm run smoke
```

不单独增加一个容易被遗漏的默认外测试命令。真实模型评测除外，它属于后续阶段。

## 9. 验收清单

- [ ] 首批 4 个真实/最小 fixture 已入库并完成匿名化。
- [ ] expectation 不包含完整模型自然语言输出。
- [ ] fixture runner 未复制生产解析逻辑。
- [ ] 14 个错误稳定得到 14 个 diagnostics/findings。
- [ ] 多行 detail 不产生独立 finding。
- [ ] 项目源码优先于生成文件进入建议列表。
- [ ] parser 结果在模型失败时完整保留。
- [ ] 高置信度结构化场景模型调用为 0。
- [ ] 需要增强的 14 个错误合并为 2～4 次调用。
- [ ] 超过预算时不丢 findings。
- [ ] 逻辑调用数与网络重试次数分开统计。
- [ ] 单个 diff chunk 可以返回两个独立 findings。
- [ ] `npm test`、`npm run build`、`npm run smoke` 全部通过。

## 10. 完成定义

以下条件全部满足后，P0 才算完成：

1. 当前真实报告中的 14→20、23 chunks 和生成文件占满建议列表都有固定回归样本。
2. 三类核心不变量——诊断边界、结果完整性、调用预算——均由 CI 自动验证。
3. 普通 CI 不调用真实模型即可覆盖模型失败、重试、非法响应和预算上限。
4. 新增真实问题时，有清晰入口将最小复现加入 fixture 和 expectation。
5. 修改 parser、batch 或 handler 后，只运行 `npm test` 即可发现上述问题的回归。
