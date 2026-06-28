# 重构计划：精简 `aux_summarize_file` Heuristic Fallback + 低代价修复

## 元数据

- 触发：2026-06-28，用户审查 `aux_summarize_file` 设计后确认
- 类型：重构
- 关联计划：[summarize-file-model-first.md](summarize-file-model-first.md) — 本计划是该施工计划的 fallback 收敛步骤的更激进版本（`analysis_status` 从 `partial` 改为 `incomplete`）

---

## Context

`aux_summarize_file` 经评估存在 7 个设计/实现问题：

| # | 优先级 | 问题 | 纳入 |
|---|--------|------|------|
| 1 | P0 | Fallback 1057 行伪跨语言 parser，违反 ADR-0001 | ✅ 核心改动 |
| 2 | P1 | Handler 读文件后 fallback 再次 `readFileSync`（重复 I/O） | ✅ |
| 3 | P1 | 模型路径无 evidence verification（符号可能是幻觉） | ✅ |
| 4 | P2 | `_meta` 手工拼接 23 行，未用共享 `assembleBaseMeta()` | ✅ |
| 5 | P2 | 两个路径 output 构建不对称，字段列表三处重复 | ✅ |
| 6 | P3 | 无 repair call（模型非 JSON 输出直接降级，无第二次尝试） | ❌ 本阶段不做 |
| 7 | P3 | 符号上限硬编码 15（大文件符号截断） | ❌ 模型路径不受此限 |

**目标**：四项改动合一——① 删除 fallback 语义提取，只留机械信号；② 消除重复读文件；③ 模型输出后校验符号是否在原文出现；④ `_meta` 统一用 `assembleBaseMeta()`。

**非目标**：
- 不改变 Zod schema（字段不变，只改值语义）
- 不删除旧输出字段
- 不改变 MCP tool name 或对外接口
- 不增加 repair call（P3）
- 不将 `assembleBaseMeta` 推广到其他工具（只改 summarize_file）

---

## 改动的文件

### 1. `src/fallback/summarize-file.ts`（核心改动，~900 行删除 / +30 行）

**保留（不改）：**
- `HeuristicSignal`、`FallbackSummarizeResult` 类型
- `langFromExtension()` — 60+ 扩展名→语言名映射
- `lineNumberOf()` — 标题/测试用例行号定位
- `detectFileKind()` — 文件类型检测
- `extractSections()` — markdown 标题提取
- `extractTestCases()` — `it()`/`test()` 用例名提取
- `extractCoveredBehaviors()` — `describe()` 行为分组
- `splitPrefixSuffix` / `joinPrefixSuffix` 智能截断
- `resolveSafePath` + 文件读取 + 截断逻辑
- 新增可选参数 `fileContent?: string`（传入则跳过读文件）

**删除：**
- `RawSymbol`、`SymbolKind` 类型
- `DSL_COMPONENT_BLOCKLIST`（38 项 set：SwiftUI/Compose/Flutter/React 组件名）
- `isDslComponent()`、`countParams()`、`buildRole()`、`escapeRegex()`
- `ExtractionPattern`、`buildPatterns()`（13 种跨语言正则）
- `extractSymbols()`（符号提取、去重、排序，最多 15 个）
- `ExtractedEvidence`、`extractEvidence()`（import/export 计数以外的部分：注释统计保留、shebang/strict mode/package 检测保留）
- `extractImportModules()`（3 种 import 风格的模块名提取）
- `buildSummary()`（带符号名列表和模块名的自然语言摘要）
- `TEST_FRAMEWORK_SYMBOLS` set

**新增逻辑（`summarizeFileFallback` 函数体内）：**

```typescript
// 只做机械计数
const totalLines = lines.length;
const nonEmptyLines = lines.filter(l => l.trim() !== "").length;
// 注释行统计（保留块注释跟踪，原 extractEvidence 中的逻辑）
let commentLines = 0;
let inBlockComment = false;
for (const line of lines) { /* 原逻辑保留 */ }

// 简单 import/export 计数（只计数量，不提取模块名）
const importCount = (text.match(/^\s*import\s+/gm) || []).length;
const exportCount = (text.match(/^\s*export\s+/gm) || []).length;

// 摘要：只包含机械事实
summary = `${filename} (${totalLines} lines, ${lang}). File kind: ${fileKind}.`;
// + import/export 计数（如果 > 0）

// important_symbols: 永远空数组
const important_symbols = [];

// evidence: 行统计、文件类型、import/export 计数、shebang、strict mode
// heuristic_signals: 仅 file_kind、line_counts、可选 truncation
// uncertainties: 明确声明"未做语义分析，建议主模型直接 Read 文件"
```

**新增 `fileContent` 可选参数：**

```typescript
export function summarizeFileFallback(
  workspaceRoot: string,
  relativePath: string,
  maxChars?: number,
  fileContent?: string,          // NEW: 传入则跳过 readFileSync
): FallbackSummarizeResult {
```

**关键语义变化：`important_symbols` 永远为 `[]`（而非"可能的声明"列表）。**

---

### 2. `src/tools/summarize-file.ts`（多项改动）

#### 2a. 消除重复读文件

**当前**：handler 在 L106 读出 `rawText`，但 `buildFallbackResult()` 接收的是 `relativePath`，fallback 内部再次 `readFileSync`。

**修改**：`buildFallbackResult` 签名增加 `fileContent: string` 参数，传递给 `summarizeFileFallback` 的 `fileContent` 可选参数。

```typescript
// handler 调用侧
result = buildFallbackResult(
  config.workspaceRoot,
  validatedInput.path,
  fileContent,                         // NEW: 已读出的内容
  maxChars,
  inputTruncated,
  provider,
  traceMeta,
);

// buildFallbackResult 签名
function buildFallbackResult(
  workspaceRoot: string,
  relativePath: string,
  fileContent: string,                 // NEW
  maxChars: number,
  inputTruncated: boolean,
  provider: string,
  traceMeta: ReturnType<typeof createTraceMeta>,
): SummarizeFileOutput { ... }
```

#### 2b. 统一使用 `assembleBaseMeta()`

**当前**：模型路径成功分支和 fallback 两个分支（正常 + 崩溃）各自手工拼装 `_meta`，约 20 行/处。

**修改**：三处全部替换为 `assembleBaseMeta()` 调用。

```typescript
import { assembleBaseMeta } from "../shared/handler-boilerplate.js";

// 模型路径成功 → _meta
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
    ? ["File was truncated, some content may not have been analyzed"]
    : undefined,
  traceMeta,
  overrides: {
    analysis_status: modelPathStatus(true, false, inputTruncated),
    ...(evidenceRejectedCount !== undefined ? {
      feedback_recommended: evidenceRejectedCount > 0 || inputTruncated,
      feedback_reason: evidenceRejectedCount > 0 ? "evidence_rejected" : (inputTruncated ? "partial_analysis" : undefined),
    } : {}),
  },
});

// Fallback 正常 → _meta
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
  limitations: ["Deterministic mechanical scan only — no semantic analysis performed. Use model-based summarizer or read the file directly."],
  traceMeta,
  overrides: {
    analysis_status: fallbackStatus("model_not_configured", false),
  },
});

// Fallback 崩溃 → _meta
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
  limitations: ["Deterministic mechanical scan failed — no analysis performed. Read the file directly."],
  traceMeta,
  overrides: {
    analysis_status: fallbackStatus("model_not_configured", false),
  },
});
```

#### 2c. 模型路径 evidence verification（新增）

**位置**：`tryModelSummarization` 中 `validateOutput` 通过后、return 前。

**逻辑**：对模型返回的 `important_symbols` 做简单签名校验——每个符号的 `name` 是否在 `fileContent` 中出现。

```typescript
// evidence verification
let evidenceRejectedCount: number | undefined;
if (parsed.important_symbols && Array.isArray(parsed.important_symbols)) {
  const unverified = (parsed.important_symbols as Array<{name: string}>)
    .filter(s => typeof s.name === "string" && !fileContent.includes(s.name));
  if (unverified.length > 0) {
    evidenceRejectedCount = unverified.length;
    log.warn("summarize_file: evidence verification — symbol names not found in source", {
      unverifiedNames: unverified.map(s => s.name),
      totalSymbols: parsed.important_symbols.length,
    });
  }
}
```

不修改 `important_symbols` 内容（保持 schema 兼容），通过 `_meta.limitations` 和 `_meta.feedback_reason` 传递校验结果。

#### 2d. `analysis_status` 语义变化

| 位置 | 旧值 | 新值 | 原因 |
|------|------|------|------|
| `buildFallbackResult` 正常 | `fallbackStatus("model_not_configured", true)` → `"partial"` | `fallbackStatus("model_not_configured", false)` → `"incomplete"` | 不再提取符号，无有效 findings |
| `buildFallbackResult` 崩溃 | `fallbackStatus("model_not_configured", false)` → `"incomplete"` | 不变 | 已经是 `"incomplete"` |

不需要改 `src/schema.ts`——`AnalysisStatusSchema` 已包含 `"incomplete"`，所有字段 `.optional()` 兼容。

---

### 3. 测试文件更新

#### `test/summarize-file-model-first.test.ts`

| 测试用例 | 改动 |
|----------|------|
| DSL 组件不被误识别为函数 | 改为：`important_symbols.length === 0` |
| 实际 struct 声明被识别 | 改为：`important_symbols` 为空数组 |
| `analysis_status === "partial"` | 改为 `"incomplete"` |
| Swift 符号角色不含 "exported" | 删除，不再适用 |
| fallback 保留尾部内容 | 改为：验证 truncation 元数据，不检查具体符号名 |
| TS 识别 class/function/interface/enum/const | 全部改为：`important_symbols` 为空，验证 mechanical evidence 存在 |

#### `test/coverage-supplement.test.ts`

| 测试用例 | 改动 |
|----------|------|
| `analysis_status: "partial"` (L376) | 改为 `"incomplete"` |
| `heuristic_signals` 含 `possible_declarations` | 删除此断言，只验证 `file_kind` 和 `line_counts` |
| `_meta.analysis_status` (L417) | 改为 `"incomplete"` |

#### `test/translatebar-report-reliability.test.ts`

| 测试用例 | 改动 |
|----------|------|
| Swift 参数计数不误报为 0 | 改为：`important_symbols` 为空数组 |
| `analysis_status: "partial"` | 改为 `"incomplete"` |

#### `test/smoke.test.ts`

| 测试用例 | 改动 |
|----------|------|
| 检查具体符号名（Greeter, greet） | 改为验证 `important_symbols.length === 0` |

---

### 4. `README.md`（同步更新）

| 位置 | 改动 |
|------|------|
| 工具定位表（L33） | `aux_summarize_file` 的"不承担的职责"补充：`heuristic fallback 不做符号提取，只提供机械统计` |
| 可靠性与安全边界（L99） | `analysis_status: incomplete`（fallback）说明 |
| "需要继续收敛的部分"（L328） | 如有相关条目则更新 |

---

### 5. `docs/plans/summarize-file-model-first.md`

更新状态从"待实施"到"已完成 — fallback 收敛步骤"，记录 `analysis_status` 语义从 `partial` 变为 `incomplete`。

---

## 不变量的保持

| 不变量 | 状态 |
|--------|------|
| 路径安全（`resolveSafePath`） | 不变 |
| 零裸崩溃（fallback 自身失败仍返回合法 JSON） | 不变 |
| `is_authoritative: false` | 不变 |
| 所有字段 Zod `.optional()` 兼容 | 不变 |
| 智能截断保留前缀+后缀 | 不变 |
| markdown/test 文件类型感知 | 保留标题提取和用例提取 |
| `feedback_recommended` / `feedback_reason` | 不变 |

---

## 验证

```bash
# 1. TypeScript 编译
npx tsc --noEmit

# 2. 受影响的测试文件
node --import tsx --test test/summarize-file-model-first.test.ts
node --import tsx --test test/coverage-supplement.test.ts
node --import tsx --test test/translatebar-report-reliability.test.ts
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
| 调用方依赖 `important_symbols` 非空来做决策 | 中 | `analysis_status: "incomplete"` + `fallback_used: true` 明确告知不可信 |
| 模型不可用环境下信息量减少 | 确定性 | 诚实的不完整比不可靠的完整更好 |
| 现有计划文档假设 `partial` 状态 | 低 | 本计划完成后更新关联文档 |

---

## 实施顺序

1. `src/fallback/summarize-file.ts` — 删除 ~900 行符号提取；新增 `fileContent` 可选参数；保留机械统计
2. `src/tools/summarize-file.ts` — `buildFallbackResult` 增加 `fileContent` + 三处 `_meta` 替换为 `assembleBaseMeta()` + evidence verification
3. `docs/plans/summarize-file-model-first.md` — 更新状态
4. 测试文件（4 个）— 符号提取断言改为验证空数组/mechanical evidence
5. `README.md` — 同步 `analysis_status` 语义变化
6. `npx tsc --noEmit` + `npm test`

---

## 改动总结

| 文件 | 改动量 | 类型 |
|------|--------|------|
| `src/fallback/summarize-file.ts` | -900 / +30 行 | 重写 |
| `src/tools/summarize-file.ts` | 净减 ~40 行 | 重构 |
| `test/summarize-file-model-first.test.ts` | 更新 8 个用例 | 适配 |
| `test/coverage-supplement.test.ts` | 更新 3 个用例 | 适配 |
| `test/translatebar-report-reliability.test.ts` | 更新 3 个用例 | 适配 |
| `test/smoke.test.ts` | 更新 2 个用例 | 适配 |
| `README.md` | 3 处更新 | 文档同步 |
| `docs/plans/summarize-file-model-first.md` | 更新状态 | 治理 |
