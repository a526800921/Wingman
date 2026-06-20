# Command Output 模型输入精简与单批策略

## 1. 背景

当前 `aux_compress_command_output` 已经能够将 14 个 TypeScript diagnostics 从原来的 23 个 chunks 降为 2 个 batches，但仍存在两个可继续优化的问题：

1. `MAX_PER_BATCH = 8` 导致 14 条 diagnostic 必然被拆成 8 + 6 两批，即使实际输入很小；
2. 模型 payload 同时包含结构化字段、`headline`、`details` 和完整 `evidence`，同一文本被重复发送，导致 payload 膨胀。

本方案将 parser 结构化结果与模型增强请求进一步解耦：仅结构化场景不调用模型；确实需要语义增强时，将 14 条紧凑 diagnostics 放入一个按实际 payload 预算控制的 batch。

## 2. 目标行为

### 2.1 仅结构化

当调用参数为 `focus: "errors only"`，且 parser 已高置信度解析全部 diagnostics 时：

```text
14 diagnostics
  → 14 canonical findings
  → 0 model batches
  → 0 model calls
```

parser 已经能够提供：

- 文件、行、列；
- TypeScript 错误码；
- headline 和 details；
- 原始 evidence；
- source kind；
- 原始出现顺序；
- 重复模式统计所需信息。

这些字段不需要模型重新提取。

### 2.2 需要语义增强

当用户明确要求根因、优先级或其他语义分析时：

```text
14 diagnostics
  → 选择需要增强的 diagnostics
  → 构造紧凑 payload
  → 根据最终 payload token/字符预算分批
  → 预期 1 batch
  → 1 model call
  → 按 diagnostic_id overlay
  → 保留 14 canonical findings
```

是否拆分由最终序列化 payload 的大小决定，不再因为 diagnostic 数量超过 8 而强制拆分。

## 3. 当前重复字段

一个 diagnostic 当前可能以以下形式发送：

```json
{
  "file": "lib/netease.ts",
  "line": 77,
  "column": 19,
  "error_code": "TS7053",
  "headline": "Element implicitly has an 'any' type...",
  "details": [
    "Property '0' does not exist on type '{}'."
  ],
  "evidence": "lib/netease.ts(77,19): error TS7053:\n  Element implicitly has an 'any' type...\n  Property '0' does not exist on type '{}'."
}
```

重复关系：

```text
file/line/column/error_code → evidence 首行中已包含
headline                    → evidence 中已包含
details                     → evidence 中已包含
```

`evidence` 应保留在服务端 canonical finding 中，不需要随模型增强请求重复发送。

## 4. 紧凑模型输入

### 4.1 单条 diagnostic

建议发送：

```json
{
  "id": "tsc-8",
  "file": "lib/netease.ts",
  "line": 77,
  "column": 19,
  "error_code": "TS7053",
  "headline": "Element implicitly has an 'any' type because expression of type '0' can't be used to index type '{}'.",
  "details": [
    "Property '0' does not exist on type '{}'."
  ],
  "source_kind": "project"
}
```

### 4.2 不发送的字段

| 字段 | 原因 |
|---|---|
| `evidence` | 服务端已有，内容与 headline/details 重复 |
| `first_seen_index` | 仅用于服务端排序 |
| `actionability` | 优先由确定性规则计算，模型可在响应中建议增强值 |
| `parser_confidence` | 高置信度场景无需发送；低置信度增强时可按需加入 |
| 完整原始 output | 已经拆解为 diagnostics，不应重复发送 |

如果某个 diagnostic 的 parser confidence 为 low，且模型确实需要原始上下文，可以只为该 diagnostic 增加裁剪后的 `raw_context`，不能恢复为所有条目都携带完整 evidence。

## 5. 14 diagnostics 的预期输入

```json
{
  "command": "npx tsc --noEmit",
  "exit_code": 2,
  "focus": "分析根因和修复优先级",
  "diagnostics": [
    {
      "id": "tsc-0",
      "file": ".next/dev/types/validator.ts",
      "line": 47,
      "column": 31,
      "error_code": "TS2344",
      "headline": "Type 'typeof import(...)' does not satisfy the constraint 'PagesPageConfig'.",
      "details": ["Property 'default' is missing."],
      "source_kind": "generated"
    },
    {
      "id": "tsc-1",
      "file": ".next/dev/types/validator.ts",
      "line": 83,
      "column": 31,
      "error_code": "TS2344",
      "headline": "Type 'typeof import(...)' does not satisfy the constraint 'ApiRouteConfig'.",
      "details": ["Property 'default' is missing."],
      "source_kind": "generated"
    },
    {
      "id": "tsc-7",
      "file": "lib/netease.ts",
      "line": 76,
      "column": 54,
      "error_code": "TS2322",
      "headline": "Type 'string' is not assignable to type 'SoundQualityType'.",
      "details": [],
      "source_kind": "project"
    },
    {
      "id": "tsc-8",
      "file": "lib/netease.ts",
      "line": 77,
      "column": 19,
      "error_code": "TS7053",
      "headline": "Element implicitly has an 'any' type because expression of type '0' can't be used to index type '{}'.",
      "details": ["Property '0' does not exist on type '{}'."],
      "source_kind": "project"
    }
  ]
}
```

实际数组包含完整 14 条。以上只展示代表性条目。

## 6. 模型响应

模型只返回可选增强字段：

```json
{
  "findings": [
    {
      "diagnostic_id": "tsc-7",
      "message": "项目源码中的音质类型不匹配。",
      "confidence": "high",
      "actionability": "high"
    }
  ]
}
```

模型不得返回或覆盖：

- file；
- line；
- column；
- error code；
- evidence；
- first seen index。

模型没有返回某个 diagnostic，不代表该 diagnostic 应被删除。

## 7. 服务端 Overlay

```text
canonical finding
  + 按 diagnostic_id 找到的模型增强字段
  = final finding
```

示例：

```json
{
  "diagnostic_id": "tsc-7",
  "file": "lib/netease.ts",
  "line": 76,
  "column": 54,
  "error_code": "TS2322",
  "message": "项目源码中的音质类型不匹配。",
  "evidence": "lib/netease.ts(76,54): error TS2322: ...",
  "confidence": "high",
  "actionability": "high"
}
```

其中结构化位置和 evidence 来自 parser，message/confidence/actionability 可以来自模型。

## 8. 分批策略

### 8.1 优先使用实际 payload 预算

当前 batch 字符预算和实际发送 payload 使用了不同字段集合，可能导致预算低估。修复后必须：

```text
先构造最终待发送 diagnostic payload
  → JSON.stringify
  → 加入 prompt 固定开销
  → 估算字符/token 数
  → 决定是否拆分
```

不能使用精简对象计算 `batchChars`，然后发送包含更多字段的另一个对象。

### 8.2 建议限制

```text
MAX_PER_BATCH：20～32，仅作为安全上限
MAX_BATCH_TOKENS：根据模型配置确定，作为主要限制
MAX_MODEL_CALLS：5，作为总调用保险
```

如果当前无法获得准确 tokenizer，可先使用保守字符预算，但必须测量最终 user message，而不是原始 output 或中间对象。

### 8.3 本样本预期

```text
仅 errors only：0 batch，0 model call
需要语义增强：14 diagnostics，预期 1 batch，1 model call
```

如果最终 payload 实测超过模型预算，可以拆成 2 批，但必须在 `_meta` 中记录实际 payload 大小和触发拆分的原因。

## 9. 模型调用条件

### 跳过模型

- `focus` 只要求 errors only；
- parser confidence 全部为 high；
- 用户只需要结构化文件、位置、错误码和消息；
- 不需要根因、优先级或语义归并建议。

### 调用模型

- 用户要求根因分析；
- 用户要求修复优先级或业务影响；
- parser 产生 low/medium confidence diagnostics；
- 混合日志无法通过确定性规则完整分类；
- 用户明确启用 enrichment。

建议最终增加明确的 `enrichment` 参数，避免仅依赖自由文本 focus 推断：

```ts
enrichment?: "off" | "auto" | "on";
```

建议默认：

```text
off  → 永不调用模型
auto → parser 足够时跳过，否则增强
on   → 在预算内执行模型增强
```

## 10. 元数据

建议输出：

```json
{
  "diagnostics_parsed": 14,
  "diagnostics_selected_for_enrichment": 14,
  "candidate_batches": 1,
  "batches_sent": 1,
  "batches_succeeded": 1,
  "batches_failed": 0,
  "model_calls_attempted": 1,
  "network_attempts": 1,
  "payload_chars": 4200,
  "payload_tokens_estimated": 1200,
  "batch_split_reason": null
}
```

仅结构化路径应为：

```json
{
  "diagnostics_parsed": 14,
  "diagnostics_selected_for_enrichment": 0,
  "candidate_batches": 0,
  "batches_sent": 0,
  "model_calls_attempted": 0
}
```

## 11. 实施任务

### P0-1：提取模型 payload builder

新增独立纯函数，将 `CommandDiagnostic` 转换为紧凑模型输入。分批预算和真实发送必须复用该函数的结果。

### P0-2：增加 enrichment 决策

在创建 batch 前判断是否需要模型。`errors only` 和高置信度 parser 场景直接返回 canonical findings。

### P0-3：按最终 payload 分批

移除 `MAX_PER_BATCH = 8` 的主导作用，将其提高为安全上限。使用最终序列化 user message 的字符或 token 预算决定拆分。

### P0-4：精确 diagnostic ID overlay

模型响应只能按 opaque `diagnostic_id` 增强 canonical finding。未返回条目保持不变。

### P1：增加显式 enrichment 参数

为 MCP 输入 schema 增加 `off | auto | on`，并在 README 中说明行为和成本差异。

## 12. 回归测试

### 12.1 `errors only`

输入真实 14-error fixture：

```text
findings = 14
candidate_batches = 0
batches_sent = 0
model calls = 0
```

### 12.2 强制 enrichment

同一 fixture：

```text
diagnostics selected = 14
candidate_batches = 1
batches_sent = 1
findings retained = 14
```

### 12.3 Payload 去重

断言发送给模型的 JSON：

- 不包含 `evidence`；
- 不包含 `first_seen_index`；
- 每个 diagnostic 只出现一次 headline；
- details 不在其他字段中重复；
- 模型响应 schema 不允许结构化位置字段。

### 12.4 预算边界

- 14 个短 diagnostics 保持 1 batch；
- 单条超长 diagnostic 不产生无限拆分；
- 超过 token/字符预算时按 diagnostic 边界拆分；
- 不在 diagnostic 中间截断；
- 达到 `MAX_MODEL_CALLS` 后仍保留全部 parser findings。

## 13. 验收标准

- [ ] `errors only` 场景使用 0 次模型调用。
- [ ] 真实 14-error fixture 在 enrichment 场景下预期使用 1 个 batch。
- [ ] 模型 payload 不包含重复 evidence。
- [ ] 分批预算基于最终实际发送内容。
- [ ] `MAX_PER_BATCH` 只作为安全限制，不作为主要拆分条件。
- [ ] 模型响应通过 exact diagnostic ID overlay。
- [ ] 无论模型返回多少增强项，最终保留 14 个 findings。
- [ ] payload 大小、模型调用数和拆分原因可从 `_meta` 验证。
- [ ] 模型失败或达到预算时返回完整 parser 结果。
