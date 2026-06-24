# Command Output Chunk 优化回归修复计划

## 1. 背景

新的真实运行报告表明，`aux_compress_command_output` 的 chunk 优化已经显著降低模型调用数量：

```text
优化前：14 个 tsc errors → 23 chunks
优化后：14 个 tsc errors → 2 batches
```

延迟目标已经达成，但模型增强与结果聚合路径引入了新的数据完整性问题：

- 14 个原始 diagnostics 最终只剩 9 个 findings；
- 多个 TS2344 finding 错误复制第一条诊断的 line、column 和 evidence；
- TS7053 的第二个位置丢失，`repeated_errors` 从 1 组退化为 0；
- `summary` 使用归并后的数量，无法表达原始错误总数；
- `first_failure` 被改成最值得修复的错误，字段语义发生漂移。

本计划在保留 2-batch 性能优化的前提下，修复结构化诊断的完整性和字段语义。

## 2. 输入基准

真实输入包含：

```text
14 个 TypeScript diagnostics
3 个文件路径
5 种错误码
约 2500 字符
```

分布：

| 文件 | 数量 | 错误码 |
|---|---:|---|
| `.next/dev/types/validator.ts` | 7 | TS2344 ×7 |
| `lib/netease.ts` | 5 | TS2322 ×1、TS7053 ×2、TS2339 ×2 |
| `pages/api/tts/__tests__/[hash].test.ts` | 2 | TS2304 ×2 |

该原始日志应匿名化后保存为：

```text
test/fixtures/command-output/tsc-real-14-errors.txt
```

优化前后对比时必须统一 `command`、`exit_code`、`focus` 和模型配置。本次报告中 exit code 分别为 2 和 1，后续基准测试不能继续使用不一致的输入元数据。

## 3. 修复目标

1. 14 个 parser diagnostics 始终保留为 14 个 canonical findings。
2. 模型只能增强已有 diagnostic，不能删除、复制或错配确定性字段。
3. 相同错误模式通过 `repeated_errors` 表达，不通过删除 findings 表达。
4. `first_failure` 保持原始输出顺序。
5. 新增或明确 `primary_actionable_failure`，表达最值得优先修复的错误。
6. summary 同时表达原始 diagnostic 数、保留 finding 数和重复模式数。
7. 模型调用仍保持 2～4 个 batch，不退回逐 diagnostic 调用。

## 4. 必须保持的不变量

### 4.1 Canonical finding 不变量

```text
每个 parser diagnostic 对应且只对应一个 canonical finding
canonical finding 总数不因模型响应减少
每个 canonical finding 具有稳定且唯一的 diagnostic_id
file、line、column、error_code、evidence 来自 parser
```

模型允许增强：

- `message`；
- `kind`，但必须符合允许的分类；
- `confidence`；
- `actionability`；
- 可选解释或归因字段。

模型禁止覆盖：

- `diagnostic_id`；
- `file`；
- `line`；
- `column`；
- `error_code`；
- 原始 `evidence`；
- `first_seen_index`。

### 4.2 重复项不变量

重复诊断仍然是独立发生的错误，必须保留所有位置：

```text
TS7053 line 77 → canonical finding
TS7053 line 78 → canonical finding
repeated_errors → count: 2，examples 包含两个位置
```

TS2344 ×7 同理。可以在重复摘要中归并模式，但不能把 7 个原始诊断压缩成 1 个 canonical finding。

### 4.3 统计不变量

```text
diagnostics_parsed = 14
findings_retained = 14
error_count = 14
repeated pattern 数单独统计
```

summary 不得使用去重后或模型返回后的数组长度冒充原始错误数。

## 5. 根因分析

### 5.1 diagnostic 映射条件不唯一

当前批量模型路径从 `diagnostic_id` 中拆出 file 和 error code，再用以下条件查找 fallback finding：

```text
finding.file === file
finding.error_code === errorCode
```

对于同一文件中的 7 个 TS2344，该条件每次都会命中第一条 line 47，导致 line、column、evidence 和 first_seen_index 被复制。

此外，用冒号拆分字符串 ID 对包含冒号的路径不安全。

### 5.2 模型结果替代完整 parser 结果

当前 `collected` 只加入模型响应中出现的 finding。模型未返回的 diagnostic 不会进入最终数组。

因此模型只返回 9 条时，其余 5 条被静默删除。

### 5.3 对 canonical findings 执行语义去重

当前模型结果收集完成后调用 command finding 去重。基于 kind、file、error code 和相似 message 的去重可能将不同位置的真实诊断合并。

该去重适合生成重复摘要，不适合 canonical finding 列表。

### 5.4 派生字段基于残缺数组计算

`summary`、`repeated_errors`、`suggested_source_checks` 等字段从模型处理后的 findings 重新计算。当模型数组已经丢失诊断时，所有派生字段会继续放大错误。

## 6. 目标数据流

```text
原始输出
  → parser
  → 14 个 CommandDiagnostic
  → 14 个 canonical findings
  → 筛选需要增强的 diagnostics
  → 组成 2～4 个 request batches
  → 模型返回 diagnostic_id + 增强字段
  → 按精确 diagnostic_id overlay
  → 未返回的 diagnostics 保持原样
  → 仍为 14 个 canonical findings
  → 独立计算重复模式、排序、建议和 summary
```

模型结果与 parser 结果的关系必须是 overlay，而不是 replacement。

## 7. 修复任务

### P0-1：为 finding 保留精确 diagnostic ID

涉及文件：

- `src/diagnostics/types.ts`
- `src/diagnostics/tsc-parser.ts`
- `src/fallback/compress-command-output.ts`
- `src/schema.ts`

实施要求：

- `diagnostic_id` 从 parser 贯穿到内部 canonical finding；
- 使用 `Map<diagnostic_id, finding>` 精确查找；
- 不再通过 `split(":")` 解析 ID；
- ID 应是不可解析的 opaque identifier；
- ID 在同一次解析中稳定且唯一；
- 测试不依赖进程级全局递增序号。

建议 ID 基于本次解析内的序号或稳定字段生成，例如：

```text
tsc-0
tsc-1
...
tsc-13
```

如果需要跨运行稳定性，可使用规范化字段哈希加同模式 occurrence index，但 P0 不需要把业务字段编码进 ID。

验收标准：

- 7 个 TS2344 能分别映射到 47、83、92、101、110、119、191；
- 路径内容不影响 ID 映射；
- 模型返回未知 ID 时不创建高置信度 canonical finding。

### P0-2：将模型处理改为 overlay

涉及文件：

- `src/tools/compress-command-output.ts`
- `src/schema.ts`

实施方式：

```text
canonical = parser findings 的完整副本
enhancements = 模型 findings 按 diagnostic_id 建 Map
for each canonical finding:
  如果存在 enhancement：只覆盖允许增强的字段
  否则：保持 parser finding
```

模型没有返回某个 diagnostic，不代表该 diagnostic 无效或应被删除。

验收标准：

- 模型返回 9/14 条时，最终仍返回 14 条；
- 单个 batch 失败时，该 batch 中所有 parser findings 仍存在；
- 全部 batch 失败时输出与纯 parser 路径等价；
- 非法模型 finding 被记录为 low confidence/discarded，不污染 canonical 列表。

### P0-3：取消 canonical findings 的语义去重

涉及文件：

- `src/tools/compress-command-output.ts`
- `src/chunking/merge.ts`

实施要求：

- canonical 列表仅按 `diagnostic_id` 防止真正的重复插入；
- 不使用相似 message、file 或 error code 删除 canonical finding；
- 语义重复归并移动到 `repeated_errors` 计算阶段；
- 相同错误模式保留所有位置和 occurrence count。

验收标准：

- TS7053 line 77 和 78 均保留；
- TS2304 beforeAll 和 afterAll 均保留；
- TS2344 ×7 均保留；
- 模型重复返回同一 diagnostic ID 时只应用一次增强，并记录重复响应。

### P0-4：重新定义派生字段

涉及文件：

- `src/tools/compress-command-output.ts`
- `src/schema.ts`
- `src/index.ts`

#### `first_failure`

定义：原始输出中第一个 error finding，按 `first_seen_index` 计算。

本样本预期：

```text
.next/dev/types/validator.ts:47 TS2344
```

#### `primary_actionable_failure`

定义：排序后最值得优先处理的项目错误。

本样本预期：

```text
lib/netease.ts:76 TS2322
```

如果暂时不扩展公开 schema，则必须保留 `first_failure` 原语义，不能用 actionable finding 替换它。

#### `repeated_errors`

从完整 14 条 canonical findings 计算。归一化键至少考虑：

- error code；
- 规范化 message；
- 可选 source kind；
- 不包含 file/line，以允许跨位置计数。

examples 保留最多 3 个不同位置。

#### `summary`

建议同时说明：

```text
Parsed 14 diagnostics and retained 14 findings.
Detected N repeated error patterns.
First failure: .next/...:47.
Primary actionable failure: lib/netease.ts:76.
```

避免使用“9 errors”描述经过模型归并或丢失后的数量。

### P1：改进调用元数据

涉及文件：

- `src/schema.ts`
- `src/index.ts`
- `src/tools/compress-command-output.ts`

建议增加或明确：

```json
{
  "diagnostics_parsed": 14,
  "findings_retained": 14,
  "candidate_batches": 2,
  "batches_sent": 2,
  "batches_succeeded": 2,
  "batches_failed": 0,
  "batches_omitted_by_budget": 0,
  "model_findings_received": 9,
  "model_enhancements_applied": 9,
  "unknown_diagnostic_ids": 0
}
```

`total_chunks` 可以保留用于传输层统计，但不能代替 diagnostic 和 finding 数量。

## 8. 回归测试

### 8.1 真实 fixture expectation

```json
{
  "fixture": "command-output/tsc-real-14-errors.txt",
  "command": "npx tsc --noEmit",
  "exit_code": 2,
  "focus": "errors only",
  "expected": {
    "diagnostics_parsed": 14,
    "findings_retained": 14,
    "candidate_batches": 2,
    "max_batches_sent": 4,
    "first_failure": {
      "file": ".next/dev/types/validator.ts",
      "line": 47,
      "error_code": "TS2344"
    },
    "primary_actionable_failure": {
      "file": "lib/netease.ts",
      "line": 76,
      "error_code": "TS2322"
    },
    "must_include_locations": [
      ".next/dev/types/validator.ts:47",
      ".next/dev/types/validator.ts:83",
      ".next/dev/types/validator.ts:92",
      ".next/dev/types/validator.ts:101",
      ".next/dev/types/validator.ts:110",
      ".next/dev/types/validator.ts:119",
      ".next/dev/types/validator.ts:191",
      "lib/netease.ts:76",
      "lib/netease.ts:77",
      "lib/netease.ts:78",
      "lib/netease.ts:98",
      "pages/api/tts/__tests__/[hash].test.ts:13",
      "pages/api/tts/__tests__/[hash].test.ts:21"
    ]
  }
}
```

同一文件同一行可能存在多个 diagnostics，例如 `lib/netease.ts:98` 的两个 TS2339。断言时应使用 `file + line + column + error_code` 或 diagnostic ID，不能只使用 `file + line`。

### 8.2 精确映射测试

fake 模型返回 7 个不同 diagnostic IDs，并为每条生成不同 message。

断言：

- 每条 message 只覆盖对应 finding；
- line、column、evidence 不发生变化；
- 顺序保持 parser 顺序；
- 未返回的 findings 保持原样。

### 8.3 部分响应测试

模型只返回 9/14 条。

断言：

```text
model_findings_received = 9
model_enhancements_applied = 9
findings_retained = 14
```

### 8.4 重复项测试

断言：

- TS7053 findings 数量为 2；
- repeated TS7053 count 为 2；
- examples 包含 line 77 和 78；
- TS2304 beforeAll/afterAll 不因错误码相同而被合并删除。

### 8.5 模型失败测试

- 第一批成功、第二批失败；
- 第一批失败、第二批成功；
- 全部失败；
- 模型返回非法 JSON；
- 模型返回未知 diagnostic ID；
- 模型重复返回同一 diagnostic ID。

所有场景都必须保留 14 条 parser findings。

## 9. 实施顺序

1. 保存并匿名化真实 14-error fixture。
2. 为当前回归建立失败测试，确认能复现 14→9 和 line 47 复制问题。
3. 为 canonical finding 贯通 `diagnostic_id`。
4. 用精确 ID Map 替换 file/error-code 模糊匹配。
5. 将模型合并改为 overlay 完整 parser findings。
6. 从 canonical 路径移除语义去重。
7. 从完整 findings 重新计算 repeated errors 和 summary。
8. 恢复 `first_failure` 原语义，并增加 `primary_actionable_failure`。
9. 补齐模型元数据和失败场景测试。
10. 运行全部测试、类型检查和 smoke test。

## 10. GitNexus 检查要求

正式修改实现前，必须分别对以下目标运行 upstream impact：

- `runTscBatchModelPath`
- `deduplicateCommandFindings`
- `deriveFromFindings`
- `diagnosticToFinding`
- `buildDiagnosticId`

如果任一目标返回 HIGH 或 CRITICAL，必须先报告影响范围并确认调整策略。完成修改后运行 `gitnexus_detect_changes`，确认只影响 command output 解析、模型增强、聚合和对应测试执行流。

## 11. 验收标准

- [ ] 14 个 diagnostics 最终保留为 14 个 findings。
- [ ] 2-batch 性能优化保持有效。
- [ ] 7 个 TS2344 均具有正确且不同的 line/evidence。
- [ ] TS7053 line 77/78 均保留，repeated count 为 2。
- [ ] TS2304 beforeAll/afterAll 均保留。
- [ ] parser 确定字段不被模型覆盖。
- [ ] 模型只返回部分 findings 时不丢诊断。
- [ ] `first_failure` 与原始顺序一致。
- [ ] `primary_actionable_failure` 指向项目源码错误。
- [ ] summary 明确区分 diagnostic、finding 和重复模式数量。
- [ ] 优化前后测试使用一致的 exit code 和其他输入参数。
- [ ] `npm test`、`npm run build`、`npm run smoke` 全部通过。
- [ ] `gitnexus_detect_changes` 只报告预期执行流。
