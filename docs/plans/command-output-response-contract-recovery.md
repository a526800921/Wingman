# Command Output 模型响应契约恢复计划

## 元数据

- 文档类型：施工计划
- 状态：已完成（实施评审通过：`docs/command-output-response-contract-implementation-review.md`）
- 日期：2026-06-20
- 依赖计划：`docs/model-first-command-output-plan.md`、`docs/phase2-validation-p0-plan.md`
- 相关 ADR：`docs/adr/0001-model-first.md`
- 公开 schema 变化：是，仅新增 optional `_meta` 可观测字段
- Migration note：`docs/migrations/model-first-output-schema.md`
- 真实报告：`E:\work\cc-music\docs\aux-model-full-test-r4.md`

## 1. 问题与证据

Round 4 使用约 3069 字符的真实 tsc 输出测试 `analysis_mode: "model_first"`：

```text
输入：14 diagnostics / 3 files / 5 error codes
模型调用：1 次
模型响应长度：7273 字符
实际输出：model_findings_received = 0，findings = 0
analysis_status：partial
```

这不是 chunk 回归。输入低于单次调用预算，实际使用 `model-first` 单批策略。

当前 `modelFirstPath` 的失败链路是：

```text
模型返回非空响应
  → JSON.parse
  → ModelFirstResponseSchema.safeParse
  → 校验失败时不记录、不抛出、不计失败
  → modelFindings 保持默认 []
  → batchesSucceeded 仍为 1
  → 输出“模型成功但 0 findings”
```

已确认严格 Schema 会在以下通用模型输出上整体失败：

- optional 字段使用 `null`；
- finding 出现 `rule_id` 等额外字段；
- 任意一个 finding 非法导致整个响应失败；
- 响应 findings 超过数组硬上限。

由于当前没有保存 Round 4 原始模型响应，尚不能断言本次命中了哪一条具体 Schema issue；但“响应契约失败被静默转换为空结果”已经可以由源码、日志和最小 Schema 复现共同确认。

## 2. 必须保持的不变量

1. 模型优先保持为默认路径，不能因一次响应契约回归把 tsc parser 恢复为所有命令的主路径。
2. `exit_code != 0` 时，“没有发现”与“没有完成分析”必须可区分。
3. 单个非法 finding 不得清空同一响应中的其他合法 findings。
4. 本地只做通用响应规范化、Schema 校验、evidence 校验和降级，不新增命令类型语义适配。
5. tsc parser 只作为精确字段校验、coverage guard 或 fallback。
6. Round 4 小输入只允许 1 次正常分析调用；仅在响应不可用时允许 1 次受限修复调用。
7. 不记录完整用户命令输出或完整模型响应。
8. `findings_retained`、verified/partial/unverified/rejected 数量必须来自同一条结果流水线。

## 3. 范围

### 包含

- 区分 transport、JSON、envelope、finding、empty-result 五类响应状态；
- 通用规范化 `null` optional 字段和可忽略额外字段；
- envelope 与 findings 分层校验，逐 finding 保留有效结果；
- 非零退出空结果的受限修复和 fallback；
- Round 4 tsc fixture、mock model 响应和元数据契约测试；
- 更新公开 `_meta`、migration note 和计划状态。

### 不包含

- 为其他编译器、测试框架或构建工具新增 parser；
- 调整通用 chunk 阈值；
- 用正则直接生成模型语义结论；
- 持久化原始模型响应；
- 同时处理 `review_diff` 的上下文误报。

## 4. 目标 symbols 与影响分析

| Symbol | 文件 | 预期修改 | GitNexus risk |
|---|---|---|---|
| `modelFirstPath` | `src/tools/compress-command-output.ts` | 接入响应状态机、逐项校验、受限恢复和 fallback | 待运行 |
| `ModelFirstFindingSchema` | `src/schema.ts` | 支持通用规范化后的 finding 契约 | 待运行 |
| `ModelFirstResponseSchema` | `src/schema.ts` | 从全有或全无校验调整为 envelope 契约 | 待运行 |
| `CompressCommandOutputOutput` | `src/schema.ts` | 增加 optional 响应诊断元数据 | 待运行 |
| `buildModelFirstSystemPrompt` | `src/prompts.ts` | 仅在评测证明必要时收紧 null/额外字段约束 | 待运行 |
| `fallbackOnlyResult` | `src/tools/compress-command-output.ts` | 复用确定性 coverage guard，保持明确降级状态 | 待运行 |

正式修改前必须逐一运行 upstream impact。若修改 MCP 输出字段，还要核对 `src/index.ts` 工具声明和 smoke consumer。

## 5. Step 0：先建立红灯测试

### 5.1 固定 Round 4 输入

将报告中的 tsc 输出匿名化后保存为 fixture，固定：

```text
14 diagnostics
7 × TS2344
1 × TS2322
2 × TS7053
2 × TS2339
2 × TS2304
```

断言旧实现会出现：

```text
模型返回非空但契约不完全合法的响应
model_findings_received = 0
findings = 0
batches_succeeded = 1
```

### 5.2 Mock model 响应矩阵

新增以下独立测试，不依赖真实远程模型：

| 场景 | 模型响应 | 预期 |
|---|---|---|
| 完全合法 | 14 个合法 findings | 保留 14 个 |
| nullable optional | `file/line/error_code: null` | 规范化后保留 finding |
| 额外字段 | finding 带 `rule_id` | 忽略未知字段或记录 warning，不清空响应 |
| 部分非法 | 13 合法 + 1 非法 | 保留 13，rejected = 1 |
| envelope 非法 | 缺少 `detected_kind` 或 findings 非数组 | 计 schema failure，进入受限恢复 |
| 非法 JSON | 截断 JSON | 计 parse failure，进入受限恢复 |
| 合法空数组 | 非零退出 + `findings: []` | 标记 empty result，不视为完整分析 |
| evidence 不存在 | finding 合法但证据编造 | 保留为 unverified/低置信或丢弃，并准确计数 |
| 修复仍失败 | 两次响应均不可用 | 使用 fallback；无法覆盖时返回 incomplete |

### 5.3 红灯确认

```text
运行命令：node --import tsx --test test/command-output-response-contract.test.ts
预期失败断言：Schema 失败被静默算成功；部分非法响应清空全部 findings
实际失败结果：实施时填写
```

未确认上述测试在旧实现上失败，不得修改生产代码。

## 6. 目标数据流

```text
模型原始响应
  → JSON 提取
      ├─ 失败：parse_failure
      └─ 成功
  → envelope 校验
      ├─ 失败：schema_failure
      └─ 成功
  → optional null 通用规范化
  → findings 逐项校验
      ├─ 合法：进入 evidence 校验
      └─ 非法：记录 rejected issue，不影响其他项
  → evidence 校验和无损聚合
  → 非零退出保护
      ├─ 有可信 findings：返回 complete/partial
      ├─ 响应不可用：最多 1 次修复调用
      └─ 仍不可用：确定性 fallback 或 incomplete
```

内部响应状态建议统一为：

```ts
type ModelResponseStatus =
  | "valid"
  | "partial_valid"
  | "empty"
  | "parse_failure"
  | "schema_failure"
  | "transport_failure";
```

## 7. 实施步骤

### 7.1 提取响应解码边界

从 `modelFirstPath` 提取纯函数，例如 `decodeModelFirstResponse(raw)`：

- 输入只包含模型原始字符串；
- 输出包含 envelope、accepted findings、rejected issues 和状态；
- 不访问命令类型，不调用 parser；
- 错误信息只保留字段路径、错误码和计数，不保留完整响应。

### 7.2 分层校验

将当前一次性 strict parse 改成两层：

1. envelope 校验 `detected_kind`、`findings` 容器和可选汇总字段；
2. 对每个 finding 单独规范化并校验。

规范化规则只处理通用 JSON 兼容问题：

```text
optional null → undefined
未知非关键字段 → strip，并记录计数
必填字段缺失/类型错误 → reject 当前 finding
```

不要通过默认值伪造 `message`、`evidence`、`kind` 或 `confidence`。

### 7.3 修正成功/失败记账

- 只有形成可用 envelope 且完成逐项校验才增加 `batches_succeeded`；
- parse/schema/transport failure 增加 `batches_failed`；
- `model_findings_received` 表示模型数组原始长度；
- `model_findings_rejected` 表示 finding 契约失败数量；
- `findings_retained` 表示 evidence 校验和聚合后的最终数量；
- 合法空数组使用 `empty`，不能与 schema failure 共用 0。

### 7.4 非零退出恢复

当 `exit_code != 0` 且没有可信 findings：

1. parse/envelope failure：在总调用预算内执行最多 1 次 JSON 修复调用；
2. 部分 finding 合法：保留合法项，不为追求满量召回自动重试；
3. 合法空结果：执行确定性 coverage guard；
4. tsc 等已有稳定 parser 可作为 fallback 返回确定性 diagnostics；
5. 未知格式无法覆盖时返回 `incomplete` 和明确 uncertainty；
6. summary 不得出现 `0 error(s)` 或“No actionable findings”之类成功暗示。

### 7.5 Prompt 调整门槛

先通过解码和可观测性获取真实 Schema issue 分布。只有评测证明某类问题高频时才调整 prompt：

- 明确 optional 字段缺失时应省略而不是输出 null；
- 明确不得增加 Schema 外字段；
- 不添加 tsc 专用示例作为主要修复。

Prompt 调整不能代替服务端对不稳定模型输出的容错。

### 7.6 真实模型回放

Mock 测试转绿后，用 Round 4 fixture 至少运行 3 次真实模型评测，记录：

- response status；
- 原始/接受/拒绝/verified finding 数；
- 模型调用和网络尝试次数；
- fallback 是否使用；
- 最终 14 个独立位置是否覆盖；
- 总耗时和 token 使用。

原始响应仅用于当次调试，不写入 fixture 或日志。

## 8. Schema Migration

保留现有字段，只新增 optional `_meta` 字段：

| 旧字段 | 新字段 | 兼容行为 | 消费方读取优先级 |
|---|---|---|---|
| 无 | `model_response_status` | 旧调用方忽略 | 用于区分 empty 与 failure |
| 无 | `model_findings_rejected` | 默认不可推断为 0 | 与 received/retained 联合读取 |
| `model_failure_reason` | 保留并扩展枚举语义 | 继续为 optional | failure 时读取 |
| `batches_succeeded/failed` | 保留并修正计数 | 字段类型不变 | 以新语义为准 |

不向公开响应暴露完整 Zod error 或原始模型响应。Migration note 需要补充新字段语义及旧版本计数不可靠的说明。

## 9. 回滚策略

- 保留 `analysis_mode` 开关；紧急回滚可临时使用 `auto`。
- 回滚实现时保留新增 optional `_meta` 字段，允许缺省，不做破坏性 Schema 回退。
- Round 4 fixture 和契约测试不得回滚。
- 触发回滚条件：真实模型路径连续出现空结果、错误保留数显著低于 deterministic fallback，或修复调用导致不可接受的延迟/费用。

## 10. 验证

```text
node --import tsx --test test/command-output-response-contract.test.ts
node --import tsx --test test/fixture-replay.test.ts
node --import tsx --test test/command-output-contract.test.ts
npm run build
npm test
npm run smoke
Round 4 fixture × 3 次真实模型回放
gitnexus_detect_changes(scope: all)
```

## 11. 完成定义

- [x] Round 4 fixture 在旧实现上稳定红灯，在新实现上转绿。(`test/command-output-response-contract.test.ts`)
- [x] 非空模型响应不会因单个 finding 非法整体变成 0 findings。(decoder per-finding validation)
- [x] nullable optional 和未知字段有通用测试，不依赖 tsc 专用逻辑。(`normalizeOptionalNull` + `stripUnknownFields`)
- [x] parse、schema、empty 和 transport failure 可区分。(`ModelResponseStatus` 6 states)
- [x] 14 个 tsc diagnostics 最终保留为 14 个独立 findings。(Round 4 replay ×3 confirmed)
- [x] Round 4 小输入正常路径只有 1 次模型调用。(`model_call_attempts = 1`)
- [x] 修复调用最多 1 次，并计入调用预算和元数据。(`model_call_attempts ≤ 2`)
- [x] 非零退出且无法形成可信 findings 时返回 incomplete 或明确 fallback，不暗示 0 errors。(coverage guard for empty/all-rejected)
- [x] tsc parser 仍只是 coverage guard/fallback。(only when model fails + non-zero + tsc_error)
- [x] 新增 `_meta` 字段已同步 `src/schema.ts`、`src/index.ts` 和 migration note。
- [x] 所有目标 symbol 已在修改前完成 GitNexus impact。(all LOW risk)
- [x] build、test、smoke 和真实模型回放通过。(216 test + 10 smoke + build + [replay ×3 证据](../validation/command-output-round4-replay-2026-06-20.md))
- [x] `gitnexus_detect_changes` 只报告 command-output 响应处理、Schema、fallback 和对应测试流程。
- [x] `docs/PLAN_MAP.md` 状态与验证证据已更新。
