# 计划地图

本文件是 Wingman 设计与实施文档的入口，也是计划状态、依赖、替代/合并/废弃关系、推荐顺序、当前阻塞项和证据链接的事实源。它不替代各专项计划；字段方案、Schema、枚举、Step 0 证据、验证方式和完成条件以 `docs/plans/*.md` 及对应 migration note 为准。

## 治理规范

本仓库只把跨阶段、影响公共契约、依赖真实反馈、与其他计划存在依赖/替代/冲突，或会反复修改同一模块的工作纳入计划治理。普通一次性任务不要加入本地图。

统一状态如下。专项计划元数据也必须使用这些中文状态；路线图、优先级计划和索引只引用状态摘要，不重新定义状态语义。

| 状态 | 含义 |
|---|---|
| 候选 | 记录了想法，但尚未承诺实施 |
| 设计中 | 正在明确范围、契约和门禁 |
| 待实施 | 当前阶段门禁已通过，但尚未开始 |
| 实施中 | 当前阶段正在修改代码或文档 |
| 已完成 | 实现、测试、证据和文档已同步 |
| 已替代 | 被另一个计划取代 |
| 已合并 | 并入另一个计划 |
| 已废弃 | 明确不再推进 |

专项计划的状态、字段方案、完成条件或验证结果变化时，必须同步本地图和所有引用该计划的总路线图、优先级计划或索引。总路线图、优先级计划和索引只记录顺序、状态摘要和专项计划链接，不复制字段级方案、枚举、Step 0 细节或完成定义。

验收治理文档时，必须用 `rg` 搜索同名计划、P 编号、状态名和关键字段，检查是否存在重复定义或漂移。同一事实只在一个事实源定义，其他文档改为链接引用。

## 文档类型

| 类型 | 作用 | 是否可直接施工 |
|---|---|---:|
| ADR | 长期架构决策与约束 | 否 |
| 战略设计 | 描述目标架构、边界和阶段 | 否 |
| 施工计划 | 明确目标 symbol、失败 fixture、步骤和迁移 | 是 |
| 验证计划 | 定义 fixtures、契约、指标和门禁 | 部分 |
| Migration note | 指导公开 API 消费方升级 | 是 |

## 总依赖图

```text
ADR-0001 模型优先
  ├─ Phase 3 方向草案（设计中）
  │   ├─ Schema 单一来源
  │   ├─ 自动回放评测平台
  │   ├─ diff 工具入口收敛
  │   └─ aux_compare_runs
  ├─ 全工具模型优先评审（战略设计）
  │   ├─ shared model-runtime（已有局部实现，仍需专项计划）
  │   ├─ summarize_file 施工计划
  │   ├─ compress_text 施工计划
  │   └─ review 工具收敛施工计划
  ├─ Command Output 模型优先（专项设计）
  │   ├─ Phase 2 diagnostic 修复
  │   ├─ overlay 回归修复
  │   ├─ payload / 单批优化
  │   └─ Round 4 模型响应契约恢复
  ├─ TranslateBar 真实报告回归修复
  │   ├─ command-output 全绿误标 failure
  │   ├─ summarize_file Swift fallback 误导参数
  │   └─ review_diff 当前日期幻觉
  ├─ MCP 工具消费方反馈闭环（已完成）
  │   └─ aux_report_tool_feedback
  ├─ 前置验证方案
  │   └─ Phase 2 P0 验证计划
  └─ Model-first 输出 schema migration
```

## 推荐实施顺序

```text
1. 先写 Round 4 失败 fixture 和模型响应契约测试 ✅
2. 修复 command-output 响应分层校验、失败记账和非零退出恢复 ✅
3. 固定 TranslateBar 真实报告红灯 fixtures ✅
4. 统一 analysis status 与 migration 语义 ✅
5. 架构精简：删幽灵模块、Schema 去重、Handler 样板消除 ✅
6. 修复 review 工具路径、证据和 fallback 语义
7. 迁移 summarize_file 大输入与 fallback
8. 迁移 compress_text 大输入与 fallback
9. 收缩旧 heuristic 语义代码
10. 运行真实模型评测与发布前回放
```

任何步骤不得跳过对应专项计划的当前阶段门禁。

## 计划索引

| 计划 | 状态 | 类型 | 依赖 |
|---|---|---|---|
| [command-output-response-contract-recovery](plans/command-output-response-contract-recovery.md) | 已完成 | 施工计划 | - |
| [wingman-mcp-translatebar-report-reliability](plans/wingman-mcp-translatebar-report-reliability.md) | 已完成 | 施工计划 | command-output-response-contract-recovery |
| [mcp-tool-feedback-loop](plans/mcp-tool-feedback-loop.md) | 已完成 | 施工计划 | wingman-mcp-translatebar-report-reliability |
| [summarize-file-model-first](plans/summarize-file-model-first.md) | 待实施 | 施工计划 | - |
| [compress-text-model-first](plans/compress-text-model-first.md) | 待实施 | 施工计划 | - |
| [review-tools-consolidation](plans/review-tools-consolidation.md) | 待实施 | 施工计划 | - |
| [npm-publish](plans/npm-publish.md) | 已完成 | 施工计划 | - |
| [unify-analysis-status](plans/unify-analysis-status.md) | 已完成 | 施工计划 | - |
| [feedback-guidance-reproducibility](plans/feedback-guidance-reproducibility.md) | 已完成 | 施工计划 | mcp-tool-feedback-loop |
| [architecture-cleanup](plans/architecture-cleanup.md) | 已完成 | 施工计划 | - |

## 当前文档状态

| 文档 | 类型 | 状态 | 依赖/关系 | 证据链接 |
|---|---|---|---|---|
| `docs/adr/0001-model-first.md` | ADR | 已完成 | 全部模型型工具的上位约束 | 本文档 |
| `PHASE3_PLAN.md` | 战略设计草案 | 设计中 | 依赖二期可靠性闭环；下次拆分为独立施工计划 | 待补专项计划 |
| `docs/model-first-all-tools-review-plan.md` | 战略设计 | 设计中 | 必须拆成专项施工计划后实施 | 本文档 |
| `docs/model-first-command-output-plan.md` | 专项设计 | 设计中 | 依赖 ADR-0001；由多个 command-output 施工方案支撑 | 本文档 |
| `docs/phase2-tools-fix-plan.md` | 施工/设计混合 | 已合并 | 早期 diagnostic 与 batch 方案；后续细节由回归/payload/response-contract 计划覆盖 | `docs/chunk-optimization-regression-fix-plan.md`、`docs/command-output-model-payload-plan.md`、`docs/plans/command-output-response-contract-recovery.md` |
| `docs/chunk-optimization-regression-fix-plan.md` | 施工计划 | 已合并 | 覆盖 replacement → overlay、canonical findings；后续由 response-contract 计划吸收 | `docs/plans/command-output-response-contract-recovery.md` |
| `docs/command-output-model-payload-plan.md` | 施工计划 | 已合并 | 覆盖紧凑 payload、单批和 enrichment；后续由 response-contract 与 runtime 计划吸收 | `docs/plans/command-output-response-contract-recovery.md`、`docs/model-first-all-tools-review-plan.md` |
| `docs/plans/command-output-response-contract-recovery.md` | 施工计划 | **已完成** (2026-06-20) | Round 4 阻断回归；优先于 command-output 后续优化与 parser 收缩 | `docs/command-output-response-contract-implementation-review.md` |
| `docs/plans/wingman-mcp-translatebar-report-reliability.md` | 施工计划 | **已完成** (2026-06-28) | TranslateBar 真实报告回归门禁；约束 summarize/review 后续计划 | 本计划“完成记录” |
| `docs/plans/mcp-tool-feedback-loop.md` | 施工计划 | **已完成** (2026-06-28) | 消费方质量反馈闭环 | 本计划“完成记录” |
| `docs/phase2-tools-validation-plan.md` | 验证战略 | 设计中 | P0 已拆到 `docs/phase2-validation-p0-plan.md` | 本文档 |
| `docs/phase2-validation-p0-plan.md` | 施工计划 | 待实施 | 前置验证 P0 | 本计划 |
| `docs/plans/summarize-file-model-first.md` | 施工计划 | 待实施 | 依赖 shared runtime、migration note；纳入 TranslateBar Swift 报告证据 | 本计划 |
| `docs/plans/compress-text-model-first.md` | 施工计划 | 待实施 | 依赖 shared runtime、migration note | 本计划 |
| `docs/plans/review-tools-consolidation.md` | 施工计划 | 待实施 | 优先于 summarize/compress；依赖 canonical diff path | 本计划 |
| `docs/migrations/model-first-output-schema.md` | Migration note | 设计中 | 约束所有公开输出 schema 变更 | 本文档 |
| `docs/plans/npm-publish.md` | 施工计划 | **已完成** (2026-06-28) | npm 发布配置与发布验证 | 本计划“完成记录” |
| `docs/plans/unify-analysis-status.md` | 施工计划 | **已完成** (2026-06-28) | 统一 analysis_status 语义与 schema migration | 本计划“完成记录”；`docs/migrations/model-first-output-schema.md` |
| `docs/plans/feedback-guidance-reproducibility.md` | 施工计划 | **已完成** (2026-06-28) | 反馈引导与可复现性增强 | 本计划”完成记录” |
| `docs/plans/architecture-cleanup.md` | 施工计划 | **已完成** (2026-06-28) | 幽灵模块清理、Schema 去重、Handler 样板消除；无外部依赖 | 本计划"完成证据" |

状态只表示当前源码观察结果，不代表已发布版本承诺。实施完成后应更新本表并附验证命令。

## 冲突处理规则

当多份计划修改同一 symbol 时：

1. ADR 与不变量优先；
2. 新施工计划优先于旧概念设计；
3. 先完成依赖计划，再开始下游计划；
4. 不连续实施多个旧方案再重构，直接实现最终目标形态；
5. 计划状态或实现发生变化时更新本地图。

## 阻塞项

- `docs/unfinished-implementation-priority-plan.md` 仍是未完成队列索引，实施细节必须回到对应专项计划。
- `PHASE3_PLAN.md` 仍是战略设计草案；进入施工前必须拆分为专项计划。
