# `aux_compress_command_output` 模型优先重构计划

## 1. 背景

当前 `aux_compress_command_output` 同时承担两类职责：

1. 使用本地规则识别并解析 tsc、eslint、test、stack trace、build 和 generic log；
2. 使用模型压缩、分类并补充语义信息。

这种架构正在产生持续的格式适配成本：

- tsc 需要状态机 parser；
- Jest 风格 test parser 无法覆盖 Vitest；
- build 工具存在 Webpack、Vite、Next.js、make 等不同格式；
- 每新增一种命令输出，都可能需要新增正则、状态机和测试；
- 本地 parser 与模型结果之间还会产生替换、去重和统计口径冲突。

该工具的核心价值是使用模型理解并压缩任意命令输出。因此本计划将架构调整为“模型优先、通用处理、最少适配”：本地代码只负责安全、预算、证据校验和无损聚合，不再以逐命令类型 parser 作为扩展主路径。

## 2. 目标

1. 默认支持任意命令输出，不要求预先实现对应 parser。
2. 小输入只调用一次模型，不按错误数量机械拆分。
3. 大输入只按通用语义边界和模型预算分批。
4. 模型输出必须引用原始 evidence，服务端验证后才能进入正式 findings。
5. 模型失败或返回空结果时，不把“无法分析”表示成“没有错误”。
6. 聚合过程不删除独立错误位置，重复模式作为独立视图展示。
7. `output_kind` 只作为 hint 和输出元数据，不再控制专用解析流程。
8. 保留少量确定性 parser 作为可选 fast path、验证器或 fallback，而不是新增命令支持的前置条件。

## 3. 非目标

- 不为 Jest、Vitest、Mocha、Webpack、Vite 等分别实现完整 parser；
- 不追求模型输出完全权威；
- 不依赖模型生成的自然语言作为唯一测试依据；
- 不在首期删除所有现有 parser；
- 不允许无限模型调用或无限重试；
- 不默认记录完整用户日志。

## 4. 目标流程

```text
MCP 输入
  → 输入校验
  → 敏感信息清理
  → 通用信号扫描和 output-kind hint
  → 计算最终模型 payload 大小
  → 是否超过单次模型预算？
      ├─ 否：整个输入一次发送
      └─ 是：按通用语义块分批
  → 模型识别类型并返回 findings[]
  → schema 校验
  → evidence 回查原始输入
  → 无损聚合
  → 独立生成重复模式、排序、建议和 summary
  → 返回结果和完整元数据
```

对于小型输入：

```text
14 个 tsc diagnostics，约 2500 字符 → 1 次模型调用
5 个 Vitest failures，约 1000 字符 → 1 次模型调用
```

只有真正超过模型输入预算时才产生多个 request batches。

## 5. 本地代码职责

模型优先不等于把所有可靠性责任交给模型。本地代码只保留以下四类核心职责。

### 5.1 输入安全

- 清理 token、cookie、密码、连接串和 URL credentials；
- 保护 prompt delimiter，避免日志中的指令改变系统行为；
- 限制最大输入字符数；
- 明确记录截断范围；
- 不默认持久化原始输出。

### 5.2 通用分块

分块器只识别跨工具通用的边界：

- 连续空行；
- `FAIL`、`ERROR`、`FATAL`、异常首行；
- 连续栈帧；
- 文件标题；
- 明显的 summary/footer；
- 最大字符或 token 预算。

分块器不需要判断具体是 Jest、Vitest、Webpack 还是 Vite。

### 5.3 Schema 与 evidence 校验

- 校验模型响应 JSON；
- 校验 finding 必填字段；
- evidence 必须能在原始输入或对应 batch 中找到；
- file、line、column、error code 应能从 evidence 或邻近上下文获得支持；
- 无证据 finding 降级或进入 `discarded_or_low_confidence`；
- 不允许模型静默覆盖服务端确定字段。

### 5.4 无损聚合和调用预算

- 不按相似 message 删除独立位置；
- 重复错误只进入 `repeated_errors`；
- 记录 batch、模型调用、重试、失败和预算省略；
- 达到预算后保留未分析块及其状态；
- 部分 batch 失败不影响其他成功结果。

## 6. Output Kind 的新定位

当前 `detectOutputKind` 可以保留，但只提供 hint：

```json
{
  "command": "npm test",
  "detector_hint": "test_output",
  "exit_code": 1,
  "output": "..."
}
```

模型返回最终判断：

```json
{
  "detected_kind": "test_output",
  "findings": []
}
```

如果模型判断与本地 hint 不同：

- 不立即覆盖或报错；
- 在 `_meta` 记录差异；
- 按模型 findings 的 evidence 质量决定是否接受；
- 将频繁差异沉淀为评测样本，而不是马上新增 parser。

## 7. 模型请求设计

### 7.1 小输入请求

```json
{
  "command": "npm test",
  "exit_code": 1,
  "focus": "errors only",
  "detector_hint": "test_output",
  "output": "<完整但已脱敏的命令输出>"
}
```

不先把未知 test 格式解析成内部 diagnostics，避免 parser 失败后丢失上下文。

### 7.2 大输入请求

```json
{
  "command": "npm test",
  "exit_code": 1,
  "focus": "errors only",
  "detector_hint": "test_output",
  "batch": {
    "id": "batch-2",
    "index": 2,
    "total": 5,
    "truncated": false
  },
  "output": "<一个完整语义块或多个相邻块>"
}
```

每个 batch 携带必要的命令上下文，但不重复完整原始日志。

### 7.3 模型响应

```json
{
  "detected_kind": "test_output",
  "summary": "5 tests failed across 5 observed failure blocks.",
  "findings": [
    {
      "finding_id": "batch-0-finding-0",
      "kind": "test_failure",
      "message": "expected ParseError to be an instance of Error",
      "file": "lib/__tests__/claude.test.ts",
      "line": 71,
      "column": 28,
      "error_code": "AssertionError",
      "test_name": "ParseError > is an instance of Error",
      "evidence": "❯ lib/__tests__/claude.test.ts:71:28",
      "confidence": "high"
    }
  ],
  "reported_totals": {
    "failures": 5,
    "failed_files": 4
  },
  "uncertainties": [
    "Observed 5 distinct FAIL file paths, while summary reports 4 failed files."
  ]
}
```

模型必须允许表达输入自身的统计矛盾，不能为了匹配 footer 而删除 finding。

## 8. Evidence 校验

### 8.1 最低要求

正式 finding 必须满足至少一种条件：

1. evidence 是原始输入的精确子串；
2. evidence 是对应 batch 的精确子串；
3. file/line/error code 可从 evidence 邻近上下文确定性验证。

### 8.2 校验结果

```text
verified    → 正式 finding
partial     → 保留但 confidence 不高于 medium
unverified  → discarded_or_low_confidence
```

### 8.3 不要求本地理解格式

服务端只执行字符串存在性、邻近范围和字段一致性检查，不需要知道 Vitest 或 tsc 语法。

## 9. 非零退出保护

必须增加统一保护：

```text
exit_code != 0
且最终 verified findings = 0
```

处理顺序：

1. 如果模型尚未调用，执行模型分析；
2. 如果模型响应非法，按预算重试；
3. 如果模型仍失败，返回 `analysis_status: incomplete`；
4. 保留高信号原始片段或 batch 元数据；
5. 不输出容易被理解为“命令没有错误”的空 summary。

建议输出：

```json
{
  "analysis_status": "incomplete",
  "summary": "Command exited with code 1, but no verified findings could be extracted.",
  "findings": [],
  "uncertainties": ["Model analysis failed after 2 network attempts."]
}
```

## 10. 通用分块策略

### 10.1 是否分块

先构造最终 user message，再计算其字符或 token 估算：

```text
payload <= single-call budget → 不分块
payload > single-call budget  → 通用语义分块
```

禁止使用以下规则作为主要分块依据：

- diagnostic 数量超过 8；
- 出现多少个 FAIL；
- error code 数量；
- output kind。

### 10.2 分块优先级

```text
完整错误块
  > 完整栈帧区域
  > 空行边界
  > 固定字符边界
```

固定字符截断只能作为最后手段，并必须增加少量 overlap 和 `truncated` 标记。

### 10.3 调用预算

建议初始值：

```text
max_model_calls: 5
model_concurrency: 2
max_model_concurrency: 4
```

单次 payload 预算根据实际模型配置确定，不在业务代码中假设所有模型具有相同上下文窗口。

## 11. 无损聚合

### 11.1 Finding 身份

模型生成的 `finding_id` 只在本次调用中唯一。服务端同时建立内部 identity：

```text
batch id
evidence occurrence
file/line/column
kind
```

### 11.2 不删除独立位置

以下两个 finding 必须同时保留：

```text
lib/netease.ts:77 TS7053
lib/netease.ts:78 TS7053
```

即使 message 完全相同，也只能在 `repeated_errors` 中建立重复组。

### 11.3 跨 batch 重复

只有 evidence 指向同一原文位置时才能视为同一 finding。相似语义不能作为删除条件。

## 12. 确定性 Adapter 策略

### 12.1 保留条件

现有 adapter 只有满足以下条件之一才保留为正式路径：

- 高频场景可显著减少模型成本；
- 需要严格精确的文件、行列号和错误码；
- 格式长期稳定；
- 有足够真实 fixture 证明可靠；
- 模型不可用时需要基本 fallback。

### 12.2 推荐保留

- tsc parser：作为 fast path、证据校验和 fallback；
- 通用 stack frame 提取：作为 evidence 辅助；
- 敏感信息清理：必须保留。

### 12.3 不优先新增

- Jest/Vitest 独立完整 parser；
- 各类 build 工具 parser；
- 每种 formatter 的专用 parser。

如果模型评测证明某类输出长期表现不足，再依据真实数据决定是否增加 adapter。

## 13. 元数据

建议统一输出：

```json
{
  "analysis_status": "complete",
  "model_attempted": true,
  "model_skip_reason": null,
  "model_failure_reason": null,
  "detector_hint": "test_output",
  "model_detected_kind": "test_output",
  "kind_mismatch": false,
  "input_chars": 1200,
  "input_truncated": false,
  "candidate_batches": 1,
  "batches_sent": 1,
  "batches_succeeded": 1,
  "batches_failed": 0,
  "model_calls_attempted": 1,
  "network_attempts": 1,
  "verified_findings": 5,
  "partial_findings": 0,
  "unverified_findings": 0
}
```

模型未运行时必须明确原因：

```text
model_not_configured
model_unavailable
explicitly_disabled
deterministic_fast_path
input_empty
```

## 14. 输入与输出 API 调整

### 14.1 输入

建议增加：

```ts
analysis_mode?: "model_first" | "auto" | "deterministic_only";
```

建议默认值：

```text
model_first
```

语义：

- `model_first`：有模型时始终使用模型；小输入一次调用；
- `auto`：可靠 fast path 可跳过模型，其他情况使用模型；
- `deterministic_only`：不调用模型，只返回本地 fallback。

### 14.2 输出

建议增加：

```ts
analysis_status: "complete" | "partial" | "incomplete";
uncertainties: string[];
reported_totals?: {
  failures?: number;
  errors?: number;
  warnings?: number;
  failed_files?: number;
};
```

保持 `is_authoritative: false`。

## 15. 实施阶段

### P0：建立模型优先通路

1. 提取统一模型请求和响应 schema；
2. 小输入直接一次调用模型；
3. 增加 evidence 精确子串校验；
4. 增加非零退出空结果保护；
5. 模型 findings 改为无损聚合；
6. 增加 model attempted/skip/failure 元数据；
7. 使用 Vitest 和 tsc 真实 fixture 回归。

### P1：通用大输入分块

1. 实现与命令类型无关的 block splitter；
2. 根据最终 payload 预算决定是否分块；
3. 增加跨 batch evidence identity；
4. 增加部分失败和预算省略状态；
5. 建立大日志、混合日志和截断 fixture。

### P2：收缩专用 parser

1. 对比 adapter 和模型路径的准确率、成本、延迟；
2. 保留有明确收益的 adapter；
3. 将其他 adapter 降为 fallback 或删除；
4. README 改为“支持任意命令输出”；
5. 使用模型评测决定后续是否新增 adapter。

## 16. 回归测试

### 16.1 Vitest 输出

```text
输入：5 个 FAIL blocks，footer 报告 4 failed files
预期：5 个 findings
预期：uncertainty 记录统计不一致
预期：1 个模型调用
```

### 16.2 tsc 输出

```text
输入：14 个 diagnostics，约 2500 字符
model_first：1 个模型调用
auto：允许可靠 fast path 为 0 次调用
findings：保留 14 个独立位置
```

### 16.3 未知 build 输出

```text
无专用 parser
模型仍能返回 verified findings
不要求新增 output kind adapter
```

### 16.4 模型失败

```text
exit_code = 1
模型失败
analysis_status = incomplete
summary 不得表示 0 errors
```

### 16.5 Evidence 编造

```text
模型返回输入中不存在的 evidence
finding 不进入 verified findings
记录为 unverified/low confidence
```

### 16.6 大输入

```text
低于预算：1 batch
超过预算：按通用块分批
达到 max_model_calls：返回 partial，不丢失未分析状态
```

## 17. GitNexus 检查要求

正式修改前，对以下目标运行 upstream impact：

- `handleCompressCommandOutput`
- `runTscBatchModelPath`
- `runChunkModelPath`
- `chunkCommandOutput`
- `compressCommandOutputFallback`
- `deriveFromFindings`

涉及 MCP 输入或输出 schema 时，同时运行 API impact/route consumers 检查；如果没有对应 HTTP route，则检查 `src/index.ts` 工具声明、smoke tests 和所有输出字段访问。

完成修改后运行 `gitnexus_detect_changes`，确认只影响预期工具流程和测试。

## 18. 验收标准

- [ ] 新命令输出不要求先实现专用 parser。
- [ ] 小型 tsc 和 test 输入均只进行 1 次模型调用。
- [ ] Vitest 真实样本得到 5 个 findings，而不是空结果。
- [ ] 输入 footer 与观察结果矛盾时保留所有 evidence 并输出 uncertainty。
- [ ] 非零退出且无 verified findings 时返回 partial/incomplete。
- [ ] 每个正式 finding 都有可回查的 evidence。
- [ ] 相同错误的不同位置不会被语义去重删除。
- [ ] 模型调用、跳过、失败和网络重试原因可观测。
- [ ] 大输入只按模型预算和通用语义边界分批。
- [ ] tsc parser 保留为可选 fast path/fallback，不成为新增命令支持模板。
- [ ] `npm test`、`npm run build` 和 `npm run smoke` 全部通过。
