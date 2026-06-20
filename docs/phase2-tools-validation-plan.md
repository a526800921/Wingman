# Phase 2 工具真实场景前置验证方案

## 1. 背景

`aux_compress_command_output`、`aux_review_diff_by_file` 等工具在真实项目中使用后，持续暴露出合成测试未覆盖的问题，例如：

- 多行 TypeScript diagnostic 被拆成多个 finding；
- 生成文件错误占据建议列表；
- chunk 数量膨胀导致大量模型调用；
- fallback 与模型结果使用不同统计口径；
- 单 finding 响应限制导致 diff 风险漏报；
- 截断、重试和模型失败未被准确反映在元数据中。

真实项目验证仍然必要，但不能作为发现基础缺陷的第一道防线。本方案用于将真实使用中发现的问题沉淀为可自动回放、可量化、可阻断回归的验证体系。

## 2. 目标

1. 将历史真实输入沉淀为可重复执行的匿名化样本库。
2. 在不调用模型的情况下验证 parser、分块、聚合和降级逻辑。
3. 对模型路径建立独立的质量、稳定性、成本和延迟评测。
4. 在 CI 中阻止结构错误、结果丢失和调用预算回归。
5. 新策略正式启用前通过 Shadow 模式与旧策略对比。
6. 确保同类问题被发现并修复后不会再次出现。

## 3. 核心原则

### 3.1 真实输入优先于理想化输入

合成数据主要覆盖明确边界条件，真实匿名化数据用于验证工具面对复杂上下文时的实际表现。两者必须同时保留，不能互相替代。

### 3.2 确定性逻辑与模型评测分离

parser、分块、聚合、排序、预算和降级属于确定性逻辑，应在普通单元测试和 CI 中稳定复现。

模型输出具有非确定性，应使用固定样本重复评测，不应把完整自然语言响应作为普通 snapshot。

### 3.3 验证不变量，而不是文案

测试应优先断言以下内容：

- finding 数量和诊断边界；
- 文件、行、列和错误码；
- 是否丢失输入中的错误；
- summary 与 findings 是否一致；
- 模型调用次数和重试次数；
- 截断、省略和 fallback 状态；
- 必须包含或禁止出现的风险类别。

模型生成的 explanation 文案不应逐字比较。

### 3.4 模型是可选增强层

格式稳定且 parser 置信度高时，应允许工具在 0 次模型调用下返回完整结果。模型失败、超时或达到预算时，确定性结果不得丢失。

## 4. 真实样本库

### 4.1 目录结构

建议新增：

```text
test/
  fixtures/
    command-output/
      tsc/
        multiline-ts2344.txt
        next-generated-types.txt
        windows-paths.txt
        pretty-ansi.txt
        watch-mode.txt
        global-config-error.txt
      eslint/
        multi-file.txt
      tests/
        vitest-multiple-failures.txt
      build/
        mixed-next-tsc.txt
      stack-trace/
        nested-causes.txt
    diffs/
      small-security.diff
      multi-file.diff
      multi-risk-single-hunk.diff
      truncated-context.diff
      generated-files.diff
    expectations/
      multiline-ts2344.json
      next-generated-types.json
      multi-risk-single-hunk.json
```

### 4.2 样本来源

- 真实项目使用报告中的输入；
- CI 中失败的命令输出；
- 用户确认的误报和漏报；
- 模型 schema 解析失败的响应；
- 延迟或调用次数异常的输入；
- 针对边界条件人工构造的最小样本。

### 4.3 匿名化要求

进入仓库前必须移除或替换：

- API key、token、cookie、密码和连接串；
- 用户名、主机名、内部域名和绝对路径；
- 私有仓库地址、客户名称和业务数据；
- 未经授权的第三方源码片段。

匿名化后仍需保留影响解析的结构，例如路径分隔符、缩进、错误码、行列号、ANSI 控制码和换行符。

### 4.4 expectation 格式

expectation 只描述稳定事实和质量阈值：

```json
{
  "fixture": "command-output/tsc/next-generated-types.txt",
  "expected": {
    "diagnostics": 14,
    "findings": 14,
    "must_include_codes": ["TS2344", "TS7053"],
    "must_include_files": ["lib/netease.ts"],
    "generated_findings": 7,
    "must_not_split_details": true,
    "max_model_calls_for_structure_only": 0,
    "max_model_calls_with_enrichment": 4
  }
}
```

不保存完整模型响应作为唯一正确答案。

## 5. 确定性契约测试

### 5.1 Parser 契约

- 一个完整 diagnostic 对应一个 finding。
- detail、代码片段和 related information 不产生独立 finding。
- Windows、POSIX 路径和无文件位置错误均可处理。
- ANSI 清理不改变错误码、位置和正文。
- 无法识别的片段进入低置信度 fallback，不伪造字段。
- 单个异常片段不影响其他 diagnostics。

### 5.2 聚合契约

- summary 的错误和警告数量等于最终 findings。
- `first_failure` 保持原始出现顺序。
- `primary_actionable_failure` 按可操作性排序。
- repeated errors 合并模式，但保留所有独立位置。
- 模型不得覆盖 parser 确定的文件、行、列和错误码。
- 部分模型批次失败时，parser findings 仍完整保留。

### 5.3 调用预算契约

- 高置信度结构化场景模型调用数为 0。
- 14 个需要增强的短 diagnostics 合并为 2～4 个 batch。
- 任何输入都不能超过 `max_model_calls`。
- 达到预算后不丢 findings。
- 逻辑模型调用数与网络重试次数分开统计。
- `_meta` 准确记录 diagnostic、batch、成功、失败和省略数量。

### 5.4 Diff 审查契约

- 一个 chunk 可以返回多个 findings。
- `files` 包含每个已分析文件及其状态。
- 无风险、失败、截断和省略状态可以区分。
- `top_risks` 来自文件级结果统一聚合。
- 跨文件 findings 不被错误合并。
- hunk 上下文不足时，控制流结论不得标为高置信度。

## 6. Property-based 与模糊测试

在固定 fixture 基础上自动生成输入变体：

- CRLF 与 LF 相互转换；
- Windows 与 POSIX 路径替换；
- 插入或移除 ANSI 颜色码；
- diagnostic 之间加入空行和无关日志；
- 改变错误顺序；
- 重复错误扩展到数百条；
- 随机截断输入；
- detail 行超长；
- npm、pnpm、Next.js 日志与 tsc 输出混合；
- diff 文件和 hunk 顺序变化。

所有变体至少满足：

```text
不崩溃
不突破模型调用预算
不丢失已成功解析的确定性结果
不产生非法 schema
不泄漏未清理的敏感信息
```

随机测试失败时必须输出 seed，并将最小失败输入沉淀为固定 fixture。

## 7. 模型评测

### 7.1 执行方式

模型评测与普通单元测试分开运行：

```text
普通 CI：确定性 parser、聚合、预算和 mock 模型测试
模型评测：固定样本，每个样本重复运行 3～5 次
```

模型评测可以按计划任务、发布前任务或显式命令运行，避免每次普通提交产生不必要成本。

### 7.2 指标

| 指标 | 含义 |
|---|---|
| schema_valid_rate | 模型响应通过 schema 校验的比例 |
| finding_recall | expectation 中必须发现的问题被召回的比例 |
| false_positive_rate | 无证据或未由 diff 引入的 finding 比例 |
| diagnostic_mapping_rate | 模型结果能映射回输入 diagnostic 的比例 |
| run_to_run_stability | 同一样本多次运行的结构化结果稳定度 |
| model_calls | 逻辑模型调用次数 |
| network_attempts | 包含重试的实际网络请求次数 |
| latency_p50/p95 | 完整工具调用延迟 |
| fallback_rate | 模型路径降级到 parser/fallback 的比例 |

### 7.3 评测阈值

初始阈值应根据基线运行确定，不能凭空设置。建立基线后，建议阻止以下回归：

- schema valid rate 明显下降；
- recall 低于已发布版本；
- false positive rate 超过允许增幅；
- P95 延迟或模型调用数显著上升；
- 同一样本稳定度明显下降；
- parser 完整结果因模型路径丢失。

## 8. CI 分层

### 8.1 每次提交

- 单元测试；
- 固定 fixture 回放；
- schema 测试；
- mock 模型的部分失败、超时和重试测试；
- 调用预算断言；
- 敏感信息清理测试；
- TypeScript 类型检查。

### 8.2 Pull Request

- 全部真实 fixture；
- property-based 测试的固定数量 seed；
- 新旧 parser 的差异报告；
- 性能和调用次数基准；
- 大输入、截断和预算边界测试。

### 8.3 发布前或定时任务

- 真实模型评测；
- 每个关键 fixture 重复运行 3～5 次；
- P50/P95 延迟统计；
- 模型供应商或模型版本对比；
- Shadow 数据差异汇总。

## 9. Shadow 验证

### 9.1 工作方式

新策略上线前同时运行新旧逻辑，但只返回当前稳定版本的结果：

```text
输入
  ├─ 当前策略 → 返回给调用方
  └─ 新策略   → 仅记录结构化指标和差异
```

Shadow 路径不得影响正式响应延迟。应异步执行，或仅对经过采样的请求启用。

### 9.2 比较内容

- findings 数量变化；
- 必须错误是否遗漏；
- 新增 finding 是否有证据；
- summary 和 findings 是否一致；
- 模型调用次数；
- 网络重试次数；
- P50/P95 延迟；
- schema 失败和 fallback 比例；
- 生成文件与项目源码的优先级变化。

### 9.3 启用条件

新策略满足以下条件后才切换为正式结果：

- 已知 fixture 全部通过；
- 不变量无回归；
- recall 不低于旧策略；
- 误报率处于允许范围；
- 模型调用和 P95 延迟不高于预算；
- Shadow 样本中没有未解释的高风险差异。

## 10. 遥测与隐私

默认只记录结构化指标，不记录完整命令输出或 diff。

建议记录：

```json
{
  "tool": "aux_compress_command_output",
  "parser_kind": "tsc",
  "input_chars": 12000,
  "diagnostics_parsed": 14,
  "candidate_batches": 3,
  "model_calls_attempted": 3,
  "network_attempts": 4,
  "fallback_used": false,
  "schema_failures": 0,
  "duration_ms": 1800
}
```

如果需要保存失败样本，必须显式启用、完成敏感信息清理，并由人工确认后才能加入 fixture。

## 11. 问题闭环

每次真实项目发现问题后执行：

```text
问题报告
  → 提取最小复现输入
  → 匿名化
  → 新增 expectation
  → 先确认测试失败
  → 修复实现
  → 确认测试通过
  → fixture 永久保留
```

缺少回归 fixture 的问题不应直接标记为完成，除非无法合法保存输入；此时至少应保存等价的合成最小复现。

## 12. 实施阶段

### P0：建立回放基础

1. 创建 fixture 与 expectation 目录。
2. 将当前真实使用报告中的输入匿名化并加入样本库。
3. 编写统一 fixture runner。
4. 为 parser、聚合和调用预算增加不变量断言。
5. 在普通 CI 中运行全部确定性回放。

### P1：增加压力与模型评测

1. 增加 property-based 输入变体。
2. 建立 mock 模型失败、超时、重试和非法 schema 测试。
3. 建立真实模型评测命令和指标输出。
4. 建立延迟与调用次数基线。
5. 在发布前流程中加入质量阈值检查。

### P2：Shadow 与持续反馈

1. 实现采样式 Shadow 执行。
2. 输出新旧策略结构化差异。
3. 建立隐私安全的失败样本收集流程。
4. 根据 Shadow 数据确定新策略切换条件。
5. 将线上发现的问题持续沉淀为 fixture。

## 13. 完成定义

满足以下条件后，可认为前置验证体系完成第一阶段建设：

1. 当前已知的真实问题均有匿名化 fixture 或等价最小复现。
2. fixture runner 可以一次回放 command output 和 diff 样本。
3. parser、聚合、模型预算和降级均有明确不变量测试。
4. 普通 CI 不依赖真实模型即可验证核心正确性。
5. 模型评测能输出 recall、误报、稳定度、调用数和延迟指标。
6. 每次新问题必须附带回归 fixture。
7. 发布前可以用 Shadow 或离线回放比较新旧策略。
8. 敏感原始输入不会被默认写入日志或仓库。
