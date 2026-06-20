# ADR-0001：模型优先架构

- 状态：Accepted
- 日期：2026-06-20
- 适用范围：Wingman 全部模型型 MCP 工具

## 背景

Wingman 的核心价值是使用辅助模型完成摘要、压缩、风险初筛和未知格式理解。早期实现为了在模型不可用时返回同构结果，为不同语言、命令输出和风险类型增加了大量正则与启发式 fallback。

随着工具扩展，这种方式产生了持续适配成本：新语言、新测试框架、新构建工具和新输出格式都可能要求新增 parser；启发式逻辑还可能将无上下文的规则命中误表达为完整语义结论。

## 决策

Wingman 采用模型优先架构：

```text
模型负责语义理解、归纳、风险判断和压缩
本地代码负责安全、确定性结构、预算、证据校验和降级
```

新增能力默认通过通用模型输入、prompt、schema 和 evidence 校验实现，不以新增专用 parser 为前置条件。

## 本地代码允许承担的职责

- 输入和输出 schema 校验；
- workspace、路径、文件和网络安全；
- 敏感信息清理与 prompt injection 防护；
- 确定性格式结构，例如 unified diff 文件/hunk 边界；
- 最终模型 payload 大小估算和调用预算；
- 超预算分块、受限并发和重试统计；
- evidence 是否存在于原始输入的验证；
- 无损聚合、canonical identity 和 omitted tracking；
- 模型不可用、失败或部分成功时的明确状态。

## 本地代码不应承担的职责

- 为每种语言维护符号理解正则；
- 为 Jest、Vitest、Mocha 等分别实现完整 parser；
- 为 Webpack、Vite、Next.js、make 等分别实现构建日志 parser；
- 使用关键词或正则直接生成高置信度语义结论；
- 将 heuristic signals 表达为已经完成的模型审查；
- 因相似 message 删除具有不同原始位置的 findings。

## 分块原则

分块只服务于模型上下文和调用预算：

```text
小输入 → 单次模型调用
大输入 → 超过最终 payload 预算后才分块
```

不能因为错误数量、文件数量或命令类型达到人为阈值就机械增加模型调用。分块必须尽量保持确定性结构边界。

## Evidence 原则

正式语义结论必须具有可回查证据：

- evidence 能在原始输入或对应 batch 中定位；
- 无法验证的模型输出降级为 partial/unverified；
- 模型不得覆盖本地确定的路径、位置、边界和 canonical identity；
- 重复模式作为额外分组，不删除独立 occurrence。

## Fallback 原则

fallback 只返回确定性事实、原始高信号片段和 heuristic signals。模型没有运行或失败时，结果必须标记为 `partial` 或 `incomplete`，不能通过同构自然语言输出伪装成完整语义分析。

## 允许新增 Adapter 的条件

只有同时满足以下条件时才考虑新增或保留专用 adapter：

1. 场景高频且格式稳定；
2. 能显著降低模型成本或延迟，或提供模型难以保证的精确字段；
3. 有真实匿名化 fixtures 和明确契约测试；
4. adapter 只提取确定性事实，不替代模型语义判断；
5. 有指标证明收益高于维护成本。

新增 adapter 的设计说明必须引用本 ADR，并解释为何通用模型路径不足。

## 状态与可观测性

所有模型型工具应逐步统一：

```text
analysis_status: complete | partial | incomplete
model_attempted
model_skip_reason
model_failure_reason
model_calls_attempted
network_attempts
candidate_batches / succeeded / failed / omitted
```

调用方必须能够区分“没有发现问题”和“没有完成分析”。

## 后果

正面影响：

- 新格式通常无需新增 parser；
- 本地语义代码和维护面缩小；
- 工具行为更符合模型辅助定位；
- heuristic 误报不会伪装成模型结论；
- 模型调用和失败状态更可观测。

代价：

- 模型可用性、成本和延迟更加重要；
- 必须建设真实 fixture、模型评测和 evidence 校验；
- 模型不可用时的 fallback 信息会更保守；
- 部分输出 schema 需要渐进扩展状态字段。

## 相关文档

- [全工具模型优先评审与重构计划](../model-first-all-tools-review-plan.md)
- [Command Output 模型优先重构计划](../model-first-command-output-plan.md)
- [真实场景前置验证方案](../phase2-tools-validation-plan.md)
