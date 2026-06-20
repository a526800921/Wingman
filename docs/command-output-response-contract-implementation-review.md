# Command Output 模型响应契约恢复实施评审

## 评审信息

- 评审日期：2026-06-20
- 评审提交：`9b87864 feat: command-output model response contract recovery`
- 对应计划：`docs/plans/command-output-response-contract-recovery.md`
- 原始报告：`E:\work\cc-music\docs\aux-model-full-test-r4.md`
- 初评结论：部分完成
- 复评结论：**全部问题已修复（2026-06-20）**

## 1. 总体结论

本次实施已经解决 Round 4 的主要根因：模型响应中的 optional `null`、额外字段或单个非法 finding，不再必然导致整个响应被静默清空。

新增 decoder 将模型响应拆成 envelope 和 finding 两层校验，并能区分：

```text
valid
partial_valid
empty
parse_failure
schema_failure
transport_failure
```

初评时，恢复路径、状态语义、计数一致性和验收自动化尚未完整实现。特别是合法空结果以及全部 findings 被逐项拒绝时，仍可能在非零退出场景返回 0 findings，而不执行计划要求的 deterministic coverage guard。

这些问题已在后续修复和复评中关闭；历史问题与证据保留在本文，最终状态以第 6 节为准。

## 2. 已正确完成的部分

### 2.1 分层响应解码

`src/decoding/command-output-decoder.ts` 已实现：

- JSON 提取和解析失败识别；
- envelope 基础结构校验；
- optional `null` 规范化；
- 未知 finding 字段剥离；
- findings 逐项校验；
- 单个 finding 非法时保留其他合法 findings；
- parse、schema、empty 和 partial-valid 状态区分。

### 2.2 原始静默失败已消除

旧实现中，`ModelFirstResponseSchema.safeParse()` 失败后会继续使用默认空数组，并把 batch 计为成功。

新实现已经能够：

- 将 parse/schema failure 计入失败状态；
- 记录 `model_response_status`；
- 记录模型接收和拒绝 finding 数；
- 对完全不可用的模型响应执行一次修复调用；
- 在模型完全失败且检测为 tsc 时使用 deterministic fallback。

### 2.3 内部字段泄漏修复

实现同时修复了 `_diagnostic_id`、`_model_verified` 泄漏到公开 findings 后导致输出 Schema 校验失败的问题。

### 2.4 基础验证通过

本次评审实际运行结果：

```text
npm run build                                          通过
node --import tsx --test test/command-output-response-contract.test.ts
                                                       29/29 通过
npm test                                               205/205 通过
npm run smoke                                          10/10 通过
```

GitNexus 对 `modelFirstPath`、`decodeModelFirstResponse` 和 `fallbackOnlyResult` 的 upstream impact 均为 LOW。

## 3. 未完成问题

### 3.1 高：合法空结果不会进入 coverage fallback

位置：`src/tools/compress-command-output.ts` 的非零退出恢复分支。

当前 deterministic fallback 只在以下条件成立时执行：

```text
batchesFailed > 0
且 batchesSucceeded === 0
```

模型返回合法 envelope，但 `findings: []` 时：

```text
model_response_status = empty
batchesSucceeded = 1
batchesFailed = 0
```

后续只会返回 `analysis_status: incomplete` 和空 findings，不会执行计划规定的 coverage guard。

同样地，如果响应为 `partial_valid`，但所有 findings 都被逐项拒绝，也不会进入 fallback。

这意味着以下回归仍然可能发生：

```text
exit_code = 1
detector_hint = tsc_error
模型返回 empty 或 0 accepted findings
最终 findings = 0
```

修复要求：非零退出且最终可信 findings 为零时，应根据响应状态决定修复调用或 deterministic coverage guard，不能只根据 batch transport/schema failure 判断。

### 3.2 中：`partial_valid` 可能被表达为 `complete`

当前 `analysis_status` 初始值为 `complete`。只要存在至少一个 verified finding，就不会因为存在 rejected findings 自动降级。

例如：

```text
模型返回 14 findings
13 accepted + 1 rejected
13 个 evidence verified
model_response_status = partial_valid
analysis_status = complete
```

这与状态语义不一致，会让调用方忽略被拒绝结果。

修复要求：`model_response_status === "partial_valid"`、存在 rejected findings 或部分输入未分析时，顶层状态不得为 `complete`。

### 3.3 中：计数发生在不同流水线阶段

当前：

```text
verified/partial/unverified → 去重前累计
findings_retained           → 去重后统计
```

如果模型返回重复 `finding_id`，可能出现：

```text
verified_findings > findings_retained
```

这违反计划中“统计字段来自同一条结果流水线”的不变量。

修复要求：先完成规范化、evidence 校验和 canonical 去重，再从最终集合派生全部计数。

### 3.4 中：`reported_totals` 的 decoder 与公开 Schema 不一致

decoder 当前接受：

- 任意非负有限 number，包括小数；
- 任意 key。

公开输出 Schema 要求：

- `failures/errors/warnings/failed_files` 等已知字段；
- 非负整数；
- 不允许额外字段。

已验证：

```text
{ errors: 1.5 }       → 最终输出 Schema 失败
{ errors: 1, foo: 2 } → 最终输出 Schema 失败
```

这会让已经成功解码的模型结果在最终输出阶段再次整体进入 fallback。

修复要求：decoder 应按公开 `ReportedTotalsSchema` 的同一字段集合和整数约束过滤，避免通过类型断言绕过契约。

### 3.5 中：缺少 handler 级恢复测试

新增的 29 个测试只直接测试：

- `ModelFirstResponseSchema`；
- `ModelFirstFindingSchema`；
- `decodeModelFirstResponse()`。

测试没有调用 `handleCompressCommandOutput()`，也没有 mock `ChatClient`，因此没有覆盖：

- 首次响应失败后的修复调用；
- 修复调用次数上限；
- empty 和 partial-valid 的 fallback；
- transport failure；
- `analysis_status` 与 `model_response_status` 联动；
- 去重后的统计一致性；
- 最终公开输出 Schema 校验。

这也是上述恢复路径问题没有被测试发现的直接原因。

### 3.6 中：真实回放脚本不是强制验收门禁

`scripts/replay-round4.ts` 会计算并打印计划检查结果，但不会在任一检查失败时设置非零退出码。

其中：

```ts
"Non-zero exit not reported as 0 errors": true
```

仍是硬编码人工确认，无法作为自动化验收证据。

修复要求：

- 任一计划检查失败时设置 `process.exitCode = 1`；
- 将 summary 的非零退出语义改为真实断言；
- 精确断言 14 个独立位置，而不是仅判断 `>= 14`；
- 保存脱敏后的汇总证据，不保存完整模型响应。

### 3.7 文档与 Schema 同步未完成

当前存在以下不一致：

- 施工计划元数据仍为 `Ready`；
- 施工计划完成定义全部未勾选；
- `docs/PLAN_MAP.md` 已标记为“已完成”；
- `src/index.ts` 的 MCP output schema 未声明新增 `_meta` 字段；
- `docs/migrations/model-first-output-schema.md` 未补充新增字段语义；
- README 未增加当前修复计划和已验证能力说明。

计划明确要求同步这些内容，因此当前文档闭环尚未完成。

## 4. 建议修复顺序

```text
P0  建立 handler 级 mock model 测试
  → 覆盖 empty、all-rejected、partial-valid、parse/schema/transport failure

P1  将非零退出保护改为基于最终可信 findings
  → empty/all-rejected 进入 coverage guard
  → 完全失败最多一次修复调用

P1  修正 analysis_status
  → partial_valid/rejected/omitted 均不得返回 complete

P1  统一最终 finding 集合和统计派生顺序

P1  收紧 reported_totals 通用规范化

P2  将 replay 脚本改为可失败的验收门禁

P2  同步 src/index.ts、migration note、README 和计划状态
```

## 5. 重新完成计划的验收条件

- [x] handler 级测试覆盖首次成功、修复成功、修复失败和 transport failure。
- [x] 非零退出的 empty 响应会执行 coverage guard 或返回明确 incomplete。
- [x] 全部 findings 被拒绝时不会被当作成功分析。
- [x] `partial_valid` 不会返回 `analysis_status: complete`。
- [x] verified/partial/unverified/rejected/retained 计数来自最终 canonical 集合。
- [x] 非法 `reported_totals` 不会导致最终输出整体 fallback。
- [x] replay 任一验收失败时进程返回非零退出码。
- [x] Round 4 三次回放均精确保留 14 个独立 diagnostics。
- [x] `src/index.ts`、migration note 和 README 已同步。
- [x] 施工计划状态、完成项和 `PLAN_MAP.md` 一致。
- [x] build、专项测试、全量测试和 smoke 全部通过。
- [x] `gitnexus_detect_changes` 只包含预期执行流。

## 6. 最终判定 (Updated 2026-06-20)

```text
主要根因修复：通过
decoder 契约：通过
handler 恢复闭环：通过 ← 已修复 (3.1 empty/all-rejected coverage guard)
状态与统计一致性：通过 ← 已修复 (3.2 partial_valid→partial, 3.3 post-dedup counts)
自动化验收门禁：通过 ← summary 使用真实断言，任一检查失败时退出非零
文档与公开 Schema 同步：通过 ← src/index.ts、migration note、README 已同步

计划状态建议：已完成
```

### 修复提交

`9b87864` (初始实施) + 后续修复含：
- P0-3.1: 非零退出 empty/all-rejected 触发 coverage guard
- P1-3.2: partial_valid/rejected → analysis_status = "partial"
- P1-3.3: 计数从最终 canonical 集合统一派生
- P1-3.4: reported_totals 按已知字段+整数约束过滤
- P1-3.5: 11 条 handler 级 mock model 测试，关键恢复分支均有显式断言
- P2-3.6: replay 脚本改为可失败验收门禁，summary 不再硬编码通过
- P2-3.7: `src/index.ts`、计划元数据、migration note、README 同步

### 验证

```text
npm test → 216/216 pass (+11 handler recovery tests)
npm run smoke → 10/10 pass
npm run build → pass
npx tsc --noEmit → 零错误
gitnexus_detect_changes → 预期范围
Round 4 replay ×3 → 每次 14/14 findings、1 次模型调用、0 fallback
```

脱敏回放证据见 `docs/validation/command-output-round4-replay-2026-06-20.md`。
