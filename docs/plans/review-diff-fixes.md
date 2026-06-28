# 修复计划：`aux_review_diff` 低代价债务清理

## 元数据

- 触发：2026-06-28，用户审查 `aux_review_diff` 设计后确认
- 类型：修复（非重构，不改核心逻辑路径）
- 状态：仅文档，待批准后实施

---

## Context

`aux_review_diff` 的 handler（373 行）是四个主要工具中最干净的——已用 `createTraceContext`、有针对性的智能 diff 截断、fallback 914 行的安全检查列表对 diff review 场景是合理的降级策略。经评估存在 5 个问题，本计划覆盖其中 3 个 P1/P2 项。

| # | 优先级 | 问题 | 纳入 |
|---|--------|------|------|
| 1 | P1 | 模型路径 `_meta` 缺 `feedback_recommended`/`feedback_reason` | ✅ |
| 2 | P2 | `_meta` 手工拼接 ×2（模型路径 L293-309、fallback L347-364） | ✅ |
| 3 | P2 | 模型路径每次跑完整 fallback（914 行）只为取 `heuristic_signals` | ✅ 改为条件触发 |
| 4 | P3 | `reviewDiffFallback` 内部朴素 `slice(0, maxChars)` 截断 | ❌ 本阶段不做 |
| 5 | P3 | 模型路径错误处理风格（throw vs return null） | ❌ 与其他工具不统一但不影响行为 |

**目标**：三项修复合一——① 模型路径补 `feedback_recommended`/`feedback_reason`；② 两处 `_meta` 替换为 `assembleBaseMeta()`；③ 模型路径只在截断或不确定性较高时附加 heuristic_signals（避免每次模型调用都跑完整 fallback）。

**非目标**：
- 不改变模型路径的 prompt 和调用策略
- 不改变 fallback 的安全检查规则（14 种 pattern）
- 不改变 `smartTruncateDiff` 截断策略
- 不改变 `reviewDiffFallback` 朴素的内部截断（P3）
- 不改变模型路径 throw→catch→fallback 的控制流模式（P3）

---

## 改动的文件

### 1. `src/tools/review-diff.ts`（3 处改动）

#### 1a. `_meta` 统一使用 `assembleBaseMeta()`

**当前**：模型路径 L293-309 和 fallback 路径 L347-364 各自手工拼装。

**修改**：两处替换为 `assembleBaseMeta()` 调用。

```typescript
import { assembleBaseMeta } from "../shared/handler-boilerplate.js";

// 模型路径 → _meta（替换 L293-309）
const meta = assembleBaseMeta({
  provider,
  modelName: config.modelName,
  totalTokens: usage?.total_tokens ?? 0,
  promptTokens: usage?.prompt_tokens,
  completionTokens: usage?.completion_tokens,
  inputTruncated,
  fallbackUsed: false,
  analysisMode: "model_analysis",
  modelUsed: true,
  modelAttempted: true,
  limitations: inputTruncated
    ? ["Diff was truncated, some changes may not have been reviewed"]
    : undefined,
  traceMeta,
  overrides: {
    analysis_status: modelPathStatus(true, false, inputTruncated),
  },
});

// Fallback 路径 → _meta（替换 L347-364）
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
  limitations: ["Pattern-based review only, no semantic analysis"],
  traceMeta,
  overrides: {
    analysis_status: fallbackStatus("model_not_configured", true),
  },
});
```

**效果**：模型路径自动获得 `feedback_recommended`（当 `inputTruncated` 时）和 `feedback_reason: "partial_analysis"`。修复 P1 问题。

#### 1b. heuristic_signals 从无条件提取改为条件触发

**当前**（L279-285）：每次模型路径都执行 `reviewDiffFallback(diff, maxChars)` 提取 heuristic_signals。

**问题**：模型调用成功时，这 914 行正则扫描的附加价值存疑——调用方已有模型分析结论。

**修改**：只在以下情况附加 heuristic_signals（fallback 结论对调用方有参考价值）：
- diff 被截断（模型未看到完整数据）
- 模型 confidence 标记为 `medium` 或更低

```typescript
// 替换 L279-285
let heuristicSignals: Array<{kind: string; location?: string; evidence: string; confidence: "low" | "medium"}> | undefined;

const shouldAttachHeuristicSignals = inputTruncated ||
  (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).confidence === "medium");

if (shouldAttachHeuristicSignals) {
  const fbResult = reviewDiffFallback(diff, maxChars);
  heuristicSignals = fbResult.possible_risks.map(r => ({
    kind: r.risk,
    location: r.location,
    evidence: r.evidence ?? "",
    confidence: (r.confidence === "high" ? "medium" : r.confidence ?? "low") as "low" | "medium",
  }));
}

// heuristic_signals 附加（替换 L292）
heuristic_signals: heuristicSignals && heuristicSignals.length > 0 ? heuristicSignals : undefined,
```

**效果**：模型正常完成且未截断时，不再多跑 914 行正则扫描。截断或低置信时仍保留对比数据。

#### 1c. `import` 清理

替换后移除不再使用的 `buildDiagnosticMeta` import（如果 `assembleBaseMeta` 已内化其调用）。

---

### 2. 测试文件

不新增 schema 字段，不改变输出语义，现有测试应全部通过。

```bash
node --import tsx --test test/coverage-supplement.test.ts  # review_diff fallback 测试
node --import tsx --test test/smoke.test.ts                 # review_diff smoke
```

---

## 不变量的保持

| 不变量 | 状态 |
|--------|------|
| `smartTruncateDiff` 截断策略 | 不变 |
| 模型路径 prompt 和调用策略 | 不变 |
| Fallback 14 种安全检查正则 | 不变 |
| `modelReview` 错误处理（throw→catch→fallback） | 不变 |
| `is_authoritative: false` | 不变 |
| `heuristic_signals` 字段保持在 schema `.optional()` | 不变 |
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

# 4. Smoke
npm run smoke
```

---

## 风险

| 风险 | 可能性 | 缓解 |
|------|--------|------|
| 模型路径首次获得 `feedback_recommended` 后调用方出现意外反馈 | 极低 | 这是补缺失字段——调用方此前收到信息不完整 |
| 模型成功+未截断时不再有 heuristic_signals，调用方依赖此字段做对比 | 低 | 调用方依赖仅在 fallback 触发时存在，模型路径本身已有权威性更高的 `possible_risks` |
| `assembleBaseMeta` 输出字段与旧手工 _meta 不完全一致 | 低 | 已在 2 个工具中验证 |

---

## 实施顺序

1. `src/tools/review-diff.ts` — 引入 `assembleBaseMeta`，替换两处 _meta 拼装
2. 同一文件 — 条件化 heuristic_signals 提取
3. 移除不再使用的 `buildDiagnosticMeta` import（如适用）
4. `npx tsc --noEmit` + `npm test`

---

## 改动总结

| 文件 | 改动量 | 类型 |
|------|--------|------|
| `src/tools/review-diff.ts` | 净减 ~25 行 | 重构 |
| `test/` | 无 schema 变更，现有测试应全通过 | 回归 |
