# 修复计划：`aux_compress_text` 低代价债务清理

## 元数据

- 触发：2026-06-28，用户审查 `aux_compress_text` 设计后确认
- 类型：修复（非重构，不改核心逻辑）
- 状态：仅文档，待批准后实施

---

## Context

`aux_compress_text` 的架构比 `summarize_file` 健康得多（fallback 275 行，关键词评分对日志/错误文本场景是合理的降级策略）。但存在 8 个低代价债务项，本计划覆盖其中 5 个 P1/P2 项。

| # | 优先级 | 问题 | 纳入 |
|---|--------|------|------|
| 1 | P2 | `_meta` 手工拼接 15 行×2 处，未用 `assembleBaseMeta()` | ✅ |
| 2 | P1 | 模型路径 `input_truncated` 用 `text.length < data.text.length` 推断，脆弱 | ✅ |
| 3 | P2 | Fallback 朴素前缀截断 `slice(0, limit)` 丢弃尾部 | ✅ |
| 4 | P2 | 无 `heuristic_signals` 字段，与其他工具不统一 | ✅ |
| 5 | P2 | 无 evidence verification（key_facts 可能包含幻觉） | ❌ 文本 claim 校验需语义匹配，本阶段不做 |
| 6 | P3 | `scoreLine` 不必要的 `export` | ✅ |
| 7 | P3 | `key_facts` 混合统计事实和原文行 | ❌ 需 schema 变更，非关键 |
| 8 | P3 | 两个路径 `inputTruncated` 来源不同（推断 vs 参数） | ✅ 随 #2 一并修复 |

**目标**：五项修复合一，不改 schema（#4 除外，新增 `.optional()` 字段），不改核心逻辑。

**非目标**：
- 不改变模型路径的 prompt 或调用策略
- 不改变 fallback 的关键词评分逻辑
- 不增加 evidence verification（P2，但方案不成熟）
- 不分离 `key_facts` 数组（P3，可后续独立做）

---

## 改动的文件

### 1. `src/tools/compress-text.ts`（核心文件，净减 ~25 行）

#### 1a. `_meta` 统一使用 `assembleBaseMeta()`

**当前**：模型路径 L160-175 和 fallback L228-245 各自手工拼装 `_meta`。

**修改**：引入 `assembleBaseMeta`，两处替换。

```typescript
import { assembleBaseMeta } from "../shared/handler-boilerplate.js";

// 模型路径成功 → _meta（替换 L159-175）
const meta = assembleBaseMeta({
  provider,
  modelName: appConfig.modelName,
  totalTokens: usage?.total_tokens ?? 0,
  promptTokens: usage?.prompt_tokens,
  completionTokens: usage?.completion_tokens,
  inputTruncated,                              // 从参数列表传入
  fallbackUsed: false,
  analysisMode: "model_analysis",
  modelUsed: true,
  modelAttempted: true,
  traceMeta,
  overrides: {
    analysis_status: modelPathStatus(true, false, inputTruncated),
  },
});

// Fallback → _meta（替换 L228-245）
const meta = assembleBaseMeta({
  provider,
  modelName: "heuristic",
  totalTokens: 0,
  promptTokens: undefined,
  completionTokens: undefined,
  inputTruncated,
  fallbackUsed: true,
  analysisMode: "heuristic_fallback",
  modelUsed: false,
  modelAttempted: false,
  modelSkipReason: "model_not_configured",
  limitations: ["Heuristic compression, may miss semantic relationships"],
  traceMeta,
  overrides: {
    analysis_status: fallbackStatus("model_not_configured", true),
  },
});
```

#### 1b. 修复 `input_truncated` bug

**当前**：

```typescript
// L166 — 用长度比较推断，脆弱
input_truncated: text.length < data.text.length,
// L168 — 硬编码 false
analysis_status: modelPathStatus(true, false, false),
```

**修改**：`tryModelCompression` 函数签名增加 `inputTruncated: boolean` 参数，handler 传入已计算的布尔值。

```typescript
async function tryModelCompression(
  text: string,
  data: CompressTextValidatedInput,
  appConfig: AppConfig,
  provider: string,
  traceMeta: ReturnType<typeof createTraceContext>["traceMeta"],
  inputTruncated: boolean,                    // NEW
): Promise<CallToolResult | null> {
```

调用侧（L90）：

```typescript
const result = await tryModelCompression(
  text, data, config as AppConfig, provider, traceMeta,
  inputTruncated,                             // NEW
);
```

模型路径 `_meta` 改用参数值（通过 1a 中的 `assembleBaseMeta` 调用自然修复）。

#### 1c. Schema 新增 `heuristic_signals`

**`src/schema.ts`** 的 `CompressTextOutput` 新增可选字段：

```typescript
export const CompressTextOutput = authoritativeMarker.merge(
  z.strictObject({
    analysis_status: AnalysisStatusSchema,
    summary: z.string(),
    key_facts: z.array(z.string()),
    discarded_or_low_confidence: z.array(z.string()),
    must_verify_in_source: z.boolean(),
    heuristic_signals: z.array(HeuristicSignalSchema).optional(),  // NEW
    _meta: ResultMetaSchema,
  }),
);
```

**`src/index.ts`** 的 tool definition `outputSchema` 同步更新（已知重复，手工同步）。

**handler fallback 路径**：`buildFallbackResult` 中从 `fallbackResult` 传入 `heuristic_signals`（见 2a）。

#### 1d. Handler 不再从 handler-boilerplate 导入 `buildDiagnosticMeta`

`buildDiagnosticMeta` 的调用已被 `assembleBaseMeta` 内化。如果 handler 没有其他 `buildDiagnosticMeta` 调用，移除该 import。

---

### 2. `src/fallback/compress-text.ts`（3 处小改）

#### 2a. 新增加 `heuristic_signals` 输出

在 `FallbackCompressResult` 接口新增字段：

```typescript
export interface FallbackCompressResult {
  summary: string;
  key_facts: string[];
  discarded_or_low_confidence: string[];
  heuristic_signals?: HeuristicSignal[];      // NEW
  must_verify_in_source: boolean;
  is_authoritative: false;
}
```

`compressTextFallback` 返回体中构造：

```typescript
import type { HeuristicSignal } from "../fallback/summarize-file.js";  // 复用类型

// 在 return 前：
const heuristic_signals: HeuristicSignal[] = [
  { kind: "line_counts", evidence: `${totalLines} total, ${nonEmptyCount} non-empty`, confidence: "medium" },
];
if (errorCount > 0) {
  heuristic_signals.push({ kind: "error_count", evidence: `${errorCount} error-level lines`, confidence: "medium" });
}
if (warnCount > 0) {
  heuristic_signals.push({ kind: "warn_count", evidence: `${warnCount} warning lines`, confidence: "medium" });
}
if (pathCount > 0) {
  heuristic_signals.push({ kind: "file_paths", evidence: `${pathCount} file path(s) detected`, confidence: "medium" });
}
if (truncated) {
  heuristic_signals.push({ kind: "truncation", evidence: `Truncated from ${originalLength} to ${limit} chars`, confidence: "medium" });
}
```

#### 2b. Fallback 朴素截断改为 `splitPrefixSuffix`

**当前**：

```typescript
const workingText = truncated ? text.slice(0, limit) : text;
```

**修改**：

```typescript
import { splitPrefixSuffix, joinPrefixSuffix } from "../model-runtime/truncation.js";

// 替换 L145
let workingText: string;
let omittedChars = 0;
if (truncated) {
  const split = splitPrefixSuffix(text, limit);
  workingText = joinPrefixSuffix(split.prefix, split.suffix, split.omittedChars);
  omittedChars = split.omittedChars;
} else {
  workingText = text;
}
```

保留 `originalLength` 到 `workingText.length` 的差异用于 `heuristic_signals` 的 truncation 信号。

#### 2c. 移除 `scoreLine` 的 `export`

```typescript
// 旧
export function scoreLine(line: string): number {

// 新
function scoreLine(line: string): number {
```

同样的 `collectMatches` 如果也不需要外部导出，一并移除 `export`。检查：

```bash
grep -rn "scoreLine\|collectMatches" test/
```

确认测试是否直接引用这些函数，如果测试调用了 `scoreLine` 或 `collectMatches`，保留 export 但加 `@internal` 注释。

**确认**：`scoreLine`、`collectMatches`、`ERROR_KEYWORDS`、`WARN_KEYWORDS` 均无测试引用，`scoreLine` 和 `collectMatches` 可安全移除 export。`ERROR_KEYWORDS` 和 `WARN_KEYWORDS` 保留 export（声明为 `const` 类型字面量，外部类型推断可能依赖）。

---

### 3. `src/schema.ts`（1 处新增）

如 1c 所述，`CompressTextOutput` 新增 `heuristic_signals: z.array(HeuristicSignalSchema).optional()`。

同时 `src/index.ts` 的 MCP JSON schema 手工同步此字段。

---

### 4. `src/fallback/summarize-file.ts`（间接影响）

`HeuristicSignal` 类型当前定义在 `src/fallback/summarize-file.ts`。`compress-text.ts` 的 fallback 需 import 此类型。如果觉得跨 fallback 模块 import 不干净，可将 `HeuristicSignal` 类型提升到共享位置（如 `src/model-runtime/types.ts` 或 `src/schema.ts` 中已存在的 `HeuristicSignalSchema` 的推断类型）。

**推荐**：从 `src/schema.ts` 的 Zod schema 推断类型（`HeuristicSignal` 已在 schema.ts L191 从 `HeuristicSignalSchema` 推断），避免跨 fallback 模块依赖。

```typescript
// compress-text.ts fallback
import type { HeuristicSignal } from "../schema.js";
```

---

### 6. `README.md`（3 处同步）

#### 6a. 工具边界对比表（L40-49）— 新增 heuristic_signals 说明

当前 `compress_text` 与 `compress_command_output` 的边界描述只讲了输入选择。在 `compress_text` 的 fallback 新增 `heuristic_signals` 后，与其他工具的契约统一，可在边界描述后补充一句：

```markdown
两个工具 fallback 均输出 `heuristic_signals` 数组，包含 `line_counts`、`error_count`、
`warn_count`、`file_paths` 和 `truncation`（截断时），供调用方在降级场景下获取
低置信度结构信号。
```

#### 6b. "需要继续收敛的部分"（L328）— 更新 compress_text 状态

**当前**：

```markdown
- `review_diff` 和 `compress_text` fallback 中仍有较多关键词和风险规则，应逐步降级为 validators/signals。
```

**改为**：

```markdown
- `compress_text` fallback 已统一输出 `heuristic_signals`；`review_diff` fallback 中仍有较多关键词和风险规则，应逐步降级为 validators/signals。
```

---

### 5. 测试文件更新

| 测试用例 | 改动 |
|----------|------|
| `"produces structured fallback output"` | 新增断言：`heuristic_signals` 数组非空，包含 `line_counts` |
| `"handles minimal text"` | 新增断言：`heuristic_signals` 存在，`kind === "line_counts"` |
| `"handles error text"` | 新增断言：`heuristic_signals` 含 `error_count` |
| `"has valid _meta fields"` | 确认 `_meta` 格式不变（`assembleBaseMeta` 输出结构兼容） |

#### `test/smoke.test.ts`

| 测试用例 | 改动 |
|----------|------|
| `"produces structured fallback output"` (L165) | 新增断言：`heuristic_signals` 数组存在 |

---

### 6. `README.md`（3 处同步）

#### 6a. 工具边界对比表（L40-49）

当前 `compress_text` 与 `compress_command_output` 的边界描述只讲了输入选择。在 `compress_text` fallback 新增 `heuristic_signals` 后，与其他工具的契约统一，可在边界描述后补充：

```markdown
两个工具 fallback 均输出 `heuristic_signals` 数组，包含 `line_counts`、`error_count`、
`warn_count`、`file_paths` 和 `truncation`（截断时），供调用方在降级场景下获取
低置信度结构信号。
```

#### 6b. "需要继续收敛的部分"（L328）— 更新 compress_text 状态

**当前**：

```markdown
- `review_diff` 和 `compress_text` fallback 中仍有较多关键词和风险规则，应逐步降级为 validators/signals。
```

**改为**：

```markdown
- `compress_text` fallback 已统一输出 `heuristic_signals`；`review_diff` fallback 中仍有较多关键词和风险规则，应逐步降级为 validators/signals。
```

---

## 不变量的保持

| 不变量 | 状态 |
|--------|------|
| 输入 Zod 校验 | 不变 |
| 模型路径 prompt 和调用策略 | 不变 |
| Fallback 关键词评分逻辑 | 不变 |
| `is_authoritative: false` | 不变 |
| `must_verify_in_source: true`（fallback） | 不变 |
| `analysis_status` 语义 | 不变（fallback 仍为 `partial`） |
| 零裸崩溃 | 不变 |

---

## 验证

```bash
# 1. TypeScript 编译
npx tsc --noEmit

# 2. 受影响的测试
node --import tsx --test test/coverage-supplement.test.ts
node --import tsx --test test/smoke.test.ts

# 3. 全量测试
npm test

# 4. Schema 校验
node --import tsx --test test/schema-analysis-status.test.ts
```

---

## 风险

| 风险 | 可能性 | 缓解 |
|------|--------|------|
| `assembleBaseMeta` 输出与旧手工 `_meta` 字段不完全一致 | 低 | 对比两个版本的字段列表，`assembleBaseMeta` 是其他工具已用过的函数 |
| `HeuristicSignal` 跨 fallback 模块 import 造成循环依赖 | 低 | 从 `schema.ts` 引入类型，不引入实现 |
| `scoreLine` 移除 export 后测试编译失败 | 中 | 先 grep 确认无测试引用，如有引用则保留 |

---

## 改动总结

| 文件 | 改动量 | 类型 |
|------|--------|------|
| `src/tools/compress-text.ts` | 净减 ~25 行 | 重构 |
| `src/fallback/compress-text.ts` | +20 行 | 修复 |
| `src/schema.ts` | +1 行 | 新增字段 |
| `src/index.ts` | +3 行 | 同步 schema |
| `test/coverage-supplement.test.ts` | 更新 4 个用例 | 适配 |
| `test/smoke.test.ts` | 更新 1 个用例 | 适配 |
| `README.md` | 3 处更新 | 文档同步 |
| `docs/plans/summarize-file-model-first.md` | 如有交叉引用则更新 | 治理 |

---

## 实施顺序

1. `src/schema.ts` — 新增 `heuristic_signals` 字段
2. `src/index.ts` — 同步 MCP JSON schema
3. `src/fallback/compress-text.ts` — 智能截断 + heuristic_signals + 移除 export
4. `src/tools/compress-text.ts` — `assembleBaseMeta` + `inputTruncated` 修复 + heuristic_signals 传递
5. 测试文件更新
6. **`README.md`** — 同步 `heuristic_signals` 变更（3 处）
7. `npx tsc --noEmit` + `npm test`
