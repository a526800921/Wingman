# 修复计划：`aux_compress_command_output` 低代价债务清理

## 元数据

- 触发：2026-06-28，用户审查 `aux_compress_command_output` 设计后确认
- 类型：修复（非重构，不改核心逻辑路径）
- 状态：仅文档，待批准后实施

---

## Context

`aux_compress_command_output` 是 Wingman 最成熟的工具（分层解码、evidence verify、repair call、确定性覆盖 guard），但 handler 1024 行的规模中约有一半是 _meta 拼装和路径分支的重复代码。经评估存在 8 个问题，本计划覆盖其中 5 个 P1/P2 项。

| # | 优先级 | 问题 | 纳入 |
|---|--------|------|------|
| 1 | P1 | `_meta` 手工拼接 ×5，字段不一致（auto path 缺 `feedback_recommended`/`feedback_reason`） | ✅ |
| 2 | P2 | Handler 未用 `createTraceContext`/`assembleBaseMeta` 共享模块 | ✅ |
| 3 | P2 | `modelFirstPath` 420 行，职责过多（单调用、repair、guard、verify、输出都在一个函数里） | ✅ |
| 4 | P2 | `as CompressCommandOutputOutput["_meta"]` 类型断言 ×5，新增必填字段不在编译期报错 | ✅ |
| 5 | P2 | `fallbackOnlyResult` 不调用 `sanitizeEvidence`，与其他路径不一致 | ✅ |
| 6 | P3 | `MAX_MODEL_CALLS=5` 硬编码 | ❌ 本阶段不做 |
| 7 | P3 | `autoPath` 的 `tokens_used` 硬编码为 0 | ❌ 本阶段不做 |
| 8 | P3 | `runChunkModelPath` tokens 未汇总到 `_meta` | ❌ 本阶段不做 |

**目标**：五项修复合一——① 抽取 `buildCommandOutputMeta()` 消除 _meta 重复和 as 断言；② auto path 补上 `feedback_recommended`/`feedback_reason`；③ handler 用上 `createTraceContext`；④ 拆分 `modelFirstPath`；⑤ fallbackOnlyResult 补 `sanitizeEvidence`。

**非目标**：
- 不改变三条路径的执行逻辑和判定条件
- 不改变 Zod schema（输出字段语义不变）
- 不改变分块策略和 MAX_MODEL_CALLS 硬编码（P3）
- 不改变 `autoPath` 的 token 统计（P3）
- 不改变 prompt 构建和模型调用策略

---

## 改动一：抽取 `buildCommandOutputMeta()` 工厂函数

### 问题

当前 handler 有五处独立拼装 `_meta`，每处 20-35 行，且 auto path 缺 `feedback_recommended`/`feedback_reason`。所有五处都用 `as CompressCommandOutputOutput["_meta"]` 强制类型断言。

### 方案

在 handler 文件中新增一个 factory 函数，集中控制 `_meta` 的构建逻辑。

```typescript
import { assembleBaseMeta } from "../shared/handler-boilerplate.js";

interface CommandOutputMetaParams {
  provider: string;
  modelName: string;
  totalTokens: number;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  inputTruncated: boolean;
  fallbackUsed: boolean;
  modelAttempted: boolean;
  modelUsed: boolean;
  analysisMode: "model_analysis" | "heuristic_fallback" | "mixed";
  analysisStatus: CompressCommandOutputOutput["analysis_status"];
  traceMeta: ReturnType<typeof createTraceMeta>;
  // ---- 可选覆盖（路径特有字段） ----
  modelSkipReason?: string;
  modelFailureReason?: string;
  confidence?: "high" | "medium" | "low";
  limitations?: string[];
  chunking?: Record<string, unknown>;
  // model-first 特有
  modelResponseStatus?: string;
  modelCallAttempts?: number;
  modelFindingsReceived?: number;
  modelFindingsRejected?: number;
  findingsRetained?: number;
  verifiedFindings?: number;
  partialFindings?: number;
  unverifiedFindings?: number;
  batchesSent?: number;
  batchesSucceeded?: number;
  batchesFailed?: number;
  batchesOmittedByBudget?: number;
  detectorHint?: string;
  modelDetectedKind?: string;
  kindMismatch?: boolean;
}

function buildCommandOutputMeta(params: CommandOutputMetaParams): Record<string, unknown> {
  const base = assembleBaseMeta({
    provider: params.provider,
    modelName: params.modelName,
    totalTokens: params.totalTokens,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    inputTruncated: params.inputTruncated,
    fallbackUsed: params.fallbackUsed,
    analysisMode: params.analysisMode,
    modelUsed: params.modelUsed,
    modelAttempted: params.modelAttempted,
    modelSkipReason: params.modelSkipReason,
    modelFailureReason: params.modelFailureReason,
    confidence: params.confidence,
    limitations: params.limitations,
    traceMeta: params.traceMeta,
    overrides: { analysis_status: params.analysisStatus },
  });

  // 追加 model-first 特有字段（assembleBaseMeta 不处理这些）
  const extra: Record<string, unknown> = {};
  if (params.chunking) extra.chunking = params.chunking;
  if (params.modelResponseStatus) extra.model_response_status = params.modelResponseStatus;
  if (params.modelCallAttempts) extra.model_call_attempts = params.modelCallAttempts;
  if (params.modelFindingsReceived !== undefined) extra.model_findings_received = params.modelFindingsReceived;
  if (params.modelFindingsRejected !== undefined) extra.model_findings_rejected = params.modelFindingsRejected;
  if (params.findingsRetained !== undefined) extra.findings_retained = params.findingsRetained;
  if (params.verifiedFindings !== undefined) extra.verified_findings = params.verifiedFindings;
  if (params.partialFindings !== undefined) extra.partial_findings = params.partialFindings;
  if (params.unverifiedFindings !== undefined) extra.unverified_findings = params.unverifiedFindings;
  if (params.batchesSent !== undefined) extra.batches_sent = params.batchesSent;
  if (params.batchesSucceeded !== undefined) extra.batches_succeeded = params.batchesSucceeded;
  if (params.batchesFailed !== undefined) extra.batches_failed = params.batchesFailed;
  if (params.batchesOmittedByBudget !== undefined) extra.batches_omitted_by_budget = params.batchesOmittedByBudget;
  if (params.detectorHint) extra.detector_hint = params.detectorHint;
  if (params.modelDetectedKind) extra.model_detected_kind = params.modelDetectedKind;
  if (params.kindMismatch !== undefined) extra.kind_mismatch = params.kindMismatch;

  return { ...base, ...extra };
}
```

**五处调用统一替换**，消除所有 `as CompressCommandOutputOutput["_meta"]` 断言。

**auto path 修复**：之前缺 `feedback_recommended`/`feedback_reason`，通过 `assembleBaseMeta` 自动计算（`fallbackUsed: !modelUsed` → `fallbackUsed=true` 时 `feedback_recommended=true, feedback_reason="fallback_used"`）。

---

## 改动二：使用 `createTraceContext`

### 问题

Handler L132-134 手动创建 trace ID：

```typescript
const tid = createTraceId();
const traceMeta = createTraceMeta(tid, "aux_compress_command_output");
const log = traceLogger(tid);
```

### 方案

替换为共享模块：

```typescript
import { createTraceContext, withDuration } from "../shared/handler-boilerplate.js";

// 替换 L131-145
const { tid, traceMeta, log } = createTraceContext("aux_compress_command_output");
```

净减 3 行，与其他工具统一。

---

## 改动三：拆分 `modelFirstPath`（420 → ~120 + ~100 + ~100 + ~100）

### 问题

`modelFirstPath` 包含四个阶段，全部在一个函数内：
1. 单次模型调用（L218-257）
2. Repair call（L260-308）
3. Deterministic success guard（L314-382）
4. Evidence verify + 输出构建（L384-596）

### 方案

保持 `modelFirstPath` 作为 orchestration 函数，提取三个子函数：

```typescript
/** 阶段 1+2：单次模型调用 + 可选 repair call */
async function callModelWithRepair(
  client: ChatClient,
  systemPrompt: string,
  userMsg: string,
  exitCode: number | undefined,
  log: ReturnType<typeof traceLogger>,
): Promise<ModelCallResult>;

interface ModelCallResult {
  responseStatus: ModelResponseStatus;
  findings: ModelFirstFinding[];
  detectedKind?: string;
  summary?: string;
  reportedTotals?: Record<string, number>;
  uncertainties: string[];
  batchesSent: number;
  batchesSucceeded: number;
  batchesFailed: number;
  modelFindingsReceived: number;
  modelFindingsRejected: number;
  modelCallAttempts: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  failureReason?: string;
}

/** 阶段 3：确定性 success guard 检查 + 覆盖 */
function applyDeterministicGuard(
  output: string,
  command: string | undefined,
  exitCode: number | undefined,
  detectorHint: string,
  modelResult: ModelCallResult,
  log: ReturnType<typeof traceLogger>,
): CompressCommandOutputOutput | null;  // 返回 null 表示 guard 未触发

/** 阶段 4：evidence verify + 输出构建 */
function buildVerifiedOutput(
  modelResult: ModelCallResult,
  output: string,
  command: string | undefined,
  exitCode: number | undefined,
  detectorHint: string,
  inputTruncated: boolean,
  provider: string,
  modelName: string,
  traceMeta: ReturnType<typeof createTraceMeta>,
): CallToolResult;
```

`modelFirstPath` 缩减为：

```typescript
async function modelFirstPath(...): Promise<CallToolResult> {
  const systemPrompt = buildModelFirstSystemPrompt();
  const userMsg = buildModelFirstUserMessage(output, command, exitCode, focus, detectorHint);

  const modelResult = await callModelWithRepair(client, systemPrompt, userMsg, exitCode, log);

  // Deterministic guard
  if (exitCode === 0) {
    const guardOutput = applyDeterministicGuard(output, command, exitCode, detectorHint, modelResult, log);
    if (guardOutput) {
      // guardOutput 已包含完整 _meta
      const validation = validateOutput("aux_compress_command_output", guardOutput);
      if (validation.ok) return { content: [{ type: "text", text: JSON.stringify(validation.data) }], isError: false };
    }
  }

  // Evidence verify + output
  return buildVerifiedOutput(modelResult, output, command, exitCode, detectorHint, inputTruncated, provider, modelName, traceMeta);
}
```

---

## 改动四：`fallbackOnlyResult` 补 `sanitizeEvidence`

### 问题

model-first 路径和 deterministic guard 都调用了 `sanitizeEvidence()`，但 `fallbackOnlyResult` 和 `autoPath` 没有。

### 方案

在 `fallbackOnlyResult` 和 `autoPath` 中，对 findings 统一调用 `sanitizeEvidence`：

```typescript
// fallbackOnlyResult（L701 之后）
fb.findings.forEach(f => { f.evidence = sanitizeEvidence(f.evidence); });

// autoPath（L617 之后）
canonicalFindings.forEach(f => { f.evidence = sanitizeEvidence(f.evidence); });
```

---

## 改动五：`src/index.ts` 和 `src/schema.ts`

### 不改

本次修复不改 Zod schema，不新增字段。`_meta` 内部字段的组装逻辑变化对调用方透明——`assembleBaseMeta` 输出的字段集合是现有手工拼装的超集。

---

## 不变量的保持

| 不变量 | 状态 |
|--------|------|
| 三条路径的执行逻辑（判定条件、分支） | 不变 |
| 分层响应解码（`decodeModelFirstResponse`） | 不变 |
| Evidence verification 三态逻辑 | 不变 |
| Non-zero exit repair call 逻辑 | 不变 |
| Deterministic success guard 触发条件和覆盖逻辑 | 不变 |
| Tsc batch overlay 和 generic chunk 逻辑 | 不变 |
| `deriveFromFindings` 派生字段计算 | 不变 |
| Zod schema 验证 | 不变 |
| 零裸崩溃（所有路径都有兜底） | 不变 |

---

## 验证

```bash
# 1. TypeScript 编译（拆分后的类型正确性）
npx tsc --noEmit

# 2. 核心契约测试
node --import tsx --test test/compress-command-output.test.ts
node --import tsx --test test/fixture-replay.test.ts
node --import tsx --test test/model-path.test.ts

# 3. Schema 校验
node --import tsx --test test/schema-analysis-status.test.ts

# 4. 全量测试
npm test

# 5. Smoke
npm run smoke
```

---

## 风险

| 风险 | 可能性 | 缓解 |
|------|--------|------|
| `assembleBaseMeta` 输出的字段与旧手工 `_meta` 不完全一致 | 低 | `assembleBaseMeta` 已在 2 个工具使用；对比字段列表确认无遗漏 |
| 拆分后函数闭包变量传递错误 | 中 | 拆分是纯提取——将代码块复制到新函数，参数化变量，调用侧传参 |
| Deterministic success guard 输出中 `_meta` 结构变化 | 低 | `buildCommandOutputMeta` 集中控制，与其他路径一致 |
| `autoPath` 新增 `feedback_recommended` 改变调用方行为 | 极低 | 这是补缺失字段——调用方此前本应收到但没有 |

---

## 实施顺序

1. 新增 `buildCommandOutputMeta()` factory 函数（handler 文件内）
2. 五处 `_meta` 拼装替换为 `buildCommandOutputMeta()` 调用
3. 替换手动 trace 为 `createTraceContext`
4. 拆分 `modelFirstPath`（提取 3 个子函数）
5. `fallbackOnlyResult` + `autoPath` 补 `sanitizeEvidence`
6. `npx tsc --noEmit` + `npm test`

---

## 改动总结

| 文件 | 改动量 | 类型 |
|------|--------|------|
| `src/tools/compress-command-output.ts` | +80 / -150 行（净减 ~70） | 重构 |
| `test/` | 无 schema 变更，现有测试应全通过 | 回归 |
