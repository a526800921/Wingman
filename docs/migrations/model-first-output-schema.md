# Model-first 输出 Schema 迁移说明

## 适用范围

本说明适用于 Wingman 模型型工具逐步新增的状态、heuristic signal 和 actionable failure 字段。

## 2026-06-20: 模型响应契约恢复新增字段

`aux_compress_command_output` 的 `_meta` 新增以下 optional 字段：

| 字段 | 类型 | 语义 |
|------|------|------|
| `model_response_status` | `string` | `valid` / `partial_valid` / `empty` / `parse_failure` / `schema_failure` / `transport_failure` |
| `model_call_attempts` | `number` | 模型调用总次数（正常路径=1，含修复=2） |
| `model_findings_rejected` | `number` | 被逐 finding 校验拒绝的 finding 数量 |

消费方注意：
- `model_response_status: "empty"` ≠ `"schema_failure"` — empty 是模型合法返回空 findings
- `model_findings_rejected > 0` 时即使 `findings_retained > 0`，analysis 不应视为完整
- 旧调用方忽略这些字段不受影响（均为 optional）

## 消费方读取原则

### 1. 优先读取 `analysis_status`

```text
complete   → 模型分析成功且输入未被省略；仍需回查原文
partial    → 部分输入、部分 batch 或 heuristic 结果可用
incomplete → 未形成可验证的完整分析
```

旧调用方如果不读取该字段，可能把 fallback summary 错误理解为完整模型结论。

### 2. `heuristic_signals` 不是正式结论

`heuristic_signals` 只表示本地规则命中了某个结构或模式。它可以用于决定下一步回查位置，但不能等同于 `possible_risks`、`findings` 或 `key_facts`。

### 3. `first_failure` 与 `primary_actionable_failure`

- `first_failure`：原始输入中按出现顺序的第一个失败。
- `primary_actionable_failure`：按 source kind 和 actionability 排序后最值得优先处理的失败。

消费方推荐：

```text
展示原始失败顺序 → first_failure
选择优先修复目标 → primary_actionable_failure ?? first_failure
```

## 兼容策略

- 新字段保持 optional 或由 handler 显式填充；
- 保留旧 summary、findings、possible_risks 等字段；
- fallback 结果使用 `partial`，不能依赖 schema 默认值推断 complete；
- `_meta.analysis_status` 与顶层状态并存时，顶层字段为主要读取位置；
- README 只承诺已实现的字段。

## 下一步

1. 移除 `AnalysisStatusSchema.default("complete")`，要求 handler 显式赋值；
2. 为所有工具补充旧输出兼容 fixture；
3. 统一 `ResultMetaSchema` 与各工具自定义 `_meta`；
4. 同步 `src/index.ts` MCP JSON schema；
5. 一个迁移周期后评估是否删除重复的 `_meta.analysis_status`。

## 调用方示例

```ts
if (result.analysis_status !== "complete") {
  // 回查原文，不把空 findings 当作没有问题。
}

const priorityFailure =
  result.primary_actionable_failure ?? result.first_failure;

for (const signal of result.heuristic_signals ?? []) {
  // 只把 signal 当作回查线索。
}
```

## 验证要求

- 旧 payload 在新 schema 下仍可解析；
- fallback 路径显式返回 partial/incomplete；
- 模型成功、截断、部分失败和完全失败状态分别有测试；
- `src/schema.ts` 与 `src/index.ts` 字段一致；
- README 和 tool description 不暗示 heuristic 等同完整分析。
