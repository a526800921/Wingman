# 修复计划：`aux_review_diff_by_file` 低代价债务清理

## 元数据

- 触发：2026-06-28，用户审查 `aux_review_diff_by_file` 设计后确认
- 类型：修复（最小改动）
- 状态：仅文档，待批准后实施

---

## Context

`aux_review_diff_by_file` 是五个工具中最干净的——570 行总计、已有 `createTraceContext`、有共享 `buildFallbackOutput()` builder、模型路径 _meta 已有 `feedback_recommended`/`feedback_reason`。仅剩 3 个低代价问题。

| # | 优先级 | 问题 | 纳入 |
|---|--------|------|------|
| 1 | P2 | 模型路径 `_meta` 是巨大的单行内联对象（L312，~150 字符），应用 `assembleBaseMeta()` | ✅ |
| 2 | P2 | `buildFallbackOutput` 的 `_meta` 手工拼装（L167-185），应用 `assembleBaseMeta()` | ✅ |
| 3 | P3 | 4 个死 import：`createTraceId, createTraceMeta, traceLogger, logDuration` 来自 `logger.js` | ✅ |

**目标**：三合一——① 两处 _meta 替换为 `assembleBaseMeta()`；② 清理死 import。

**非目标**：
- 不改变分块策略和并发逻辑
- 不改变 fallback 安全检查模式
- 不改变 Zod schema

---

## 改动的文件

### 1. `src/tools/review-diff-by-file.ts`（1 个文件，3 处改动）

#### 1a. 模型路径 _meta 替换为 `assembleBaseMeta()`

**当前**（L312）：单行内联，难以阅读但功能正确。

**修改**：

```typescript
import { assembleBaseMeta } from "../shared/handler-boilerplate.js";

// 替换 L312
const output: ReviewDiffByFileOutput = {
  overall_summary: `Model review of ${chunks.length} chunk(s) across ${files.length} file(s). ${sorted.length} finding(s).`,
  files,
  top_risks: sorted.slice(0, 10),
  omitted_files: meta.omitted.map(o => ({ file: o.source ?? o.label, reason: o.reason })),
  is_authoritative: false,
  analysis_status: meta.input_truncated ? "partial" : "complete" as const,
  _meta: assembleBaseMeta({
    provider,
    modelName: (config as AppConfig).modelName,
    totalTokens,
    promptTokens: totalPromptTokens || undefined,
    completionTokens: totalCompletionTokens || undefined,
    inputTruncated: meta.input_truncated,
    fallbackUsed: false,
    analysisMode: "model_analysis",
    modelUsed: true,
    modelAttempted: true,
    traceMeta,
    overrides: {
      analysis_status: meta.input_truncated ? "partial" : "complete" as const,
      chunking: meta,
    },
  }),
};
```

**效果**：`feedback_recommended`/`feedback_reason` 由 `assembleBaseMeta` 自动计算（`inputTruncated` → `feedback_recommended: true, feedback_reason: "partial_analysis"`），保持与旧代码一致。

#### 1b. `buildFallbackOutput` _meta 替换为 `assembleBaseMeta()`

**修改**（L167-185 替换）：

```typescript
function buildFallbackOutput(
  fb: ReturnType<typeof reviewDiffByFileFallback>,
  provider: string,
  meta: ChunkMeta,
  traceMeta: ReturnType<typeof createTraceMeta>,
): ReviewDiffByFileOutput {
  // ... same as before: fbFindings → dedup → sort ...

  return {
    overall_summary: fb.overall_summary,
    files: fb.files,
    top_risks: sorted.slice(0, 10),
    omitted_files: fb.omitted_files,
    analysis_status: "partial" as const,
    is_authoritative: false,
    _meta: assembleBaseMeta({
      provider,
      modelName: "heuristic",
      totalTokens: 0,
      promptTokens: undefined,
      completionTokens: undefined,
      inputTruncated: meta.input_truncated,
      fallbackUsed: true,
      analysisMode: "heuristic_fallback",
      modelUsed: false,
      modelAttempted: false,
      modelSkipReason: "model_not_configured",
      limitations: ["Pattern-based review only, no semantic analysis"],
      traceMeta,
      overrides: {
        analysis_status: "partial" as const,
        chunking: meta,
      },
    }),
  };
}
```

#### 1c. 清理死 import

**删除 L25**：

```typescript
// 删除这行
import { createTraceId, createTraceMeta, traceLogger, logDuration } from "../logger.js";
```

这四个符号未被文件内任何代码使用——trace 和 log 已由 `createTraceContext` 覆盖。

#### 1d. 移除不再使用的 import

替换后如 `buildDiagnosticMeta` 不再被直接调用，移除对应 import。

---

## 不变量的保持

| 不变量 | 状态 |
|--------|------|
| `chunkDiff` 分块策略 | 不变 |
| 小型 diff 单次调用优化 | 不变 |
| 并发分块模型调用（concurrency=2, max=20） | 不变 |
| Fallback `analyzeFileChunk` 模式扫描 | 不变 |
| `deduplicateFindings` + `sortFindings` + `aggregateByFile` | 不变 |
| `is_authoritative: false` | 不变 |
| 零裸崩溃 | 不变 |

---

## 验证

```bash
# 1. TypeScript 编译
npx tsc --noEmit

# 2. 相关测试
node --import tsx --test test/coverage-supplement.test.ts
node --import tsx --test test/smoke.test.ts

# 3. 全量测试
npm test
```

---

## 风险

| 风险 | 可能性 | 缓解 |
|------|--------|------|
| `assembleBaseMeta` 输出字段与旧 _meta 不一致 | 极低 | 旧代码已在 L312 包含了 `feedback_recommended`/`feedback_reason`，`assembleBaseMeta` 同样生成 |
| 死 import 删除影响其他隐式依赖 | 无 | grep 确认无引用 |

---

## 实施顺序

1. `src/tools/review-diff-by-file.ts` — 引入 `assembleBaseMeta`，替换两处 _meta
2. 同一文件 — 删除死 import + 移除不再使用的 import
3. `npx tsc --noEmit` + `npm test`

---

## 改动总结

| 文件 | 改动量 | 类型 |
|------|--------|------|
| `src/tools/review-diff-by-file.ts` | 净减 ~10 行 | 重构 |
| `test/` | 无变更 | 回归 |
