# 计划地图

本文件是 Wingman 设计与实施文档的入口，用于说明文档类型、依赖、状态和推荐实施顺序。它不替代各专项计划。

## 治理规范

本仓库只把跨阶段、影响公共契约、依赖真实反馈、与其他计划存在依赖/替代/冲突，或会反复修改同一模块的工作纳入计划治理。普通一次性任务不要加入本地图。

统一状态：

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

实施前必须满足：

1. 目标、范围、非目标明确；
2. 必要的不变量、信任边界、公共契约和失败策略明确；
3. Step 0 证据存在；
4. 验证方式可运行；
5. 当前阶段没有未解决阻塞项。

只实施当前阶段。新信息改变 ADR、计划顺序、依赖、公共 API、Schema、状态语义、兼容承诺、失败模式或完成证据时，先更新本地图和相关计划，再继续实施。

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
  ├─ Phase 3 方向草案（待具体设计）
  │   ├─ Schema 单一来源
  │   ├─ 自动回放评测平台
  │   ├─ diff 工具入口收敛
  │   └─ aux_compare_runs
  ├─ 全工具模型优先评审（战略设计）
  │   ├─ shared model-runtime（部分完成）
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
  │   └─ P0 fixtures / 契约 / 调用预算
  └─ Model-first 输出 schema migration
```

## 推荐实施顺序

```text
1. 先写 Round 4 失败 fixture 和模型响应契约测试
2. 修复 command-output 响应分层校验、失败记账和非零退出恢复
3. 固定 TranslateBar 真实报告红灯 fixtures，并修复全绿误标 failure、Swift fallback 误导参数、当前日期幻觉
4. 统一 analysis status 与 migration 语义
5. 完善共享 model-runtime 和 mock model 测试
6. 修复 review 工具路径、证据和 fallback 语义
7. 迁移 summarize_file 大输入与 fallback
8. 迁移 compress_text 大输入与 fallback
9. 收缩旧 heuristic 语义代码
10. 运行真实模型评测与发布前回放
```

任何步骤不得跳过对应施工计划中的 Step 0 红灯测试。

## 当前文档状态

| 文档 | 类型 | 状态 | 依赖/被替代关系 |
|---|---|---|---|
| `docs/adr/0001-model-first.md` | ADR | 已完成 | 全部模型型工具的上位约束 |
| `PHASE3_PLAN.md` | 战略设计草案 | 设计中 | 依赖二期可靠性闭环；下次拆分为独立施工计划 |
| `docs/model-first-all-tools-review-plan.md` | 战略设计 | 设计中 | 必须拆成专项施工计划后实施 |
| `docs/model-first-command-output-plan.md` | 专项设计 | 部分完成 | 依赖 ADR-0001；由多个 command-output 施工方案支撑 |
| `docs/phase2-tools-fix-plan.md` | 施工/设计混合 | 大部分完成 | 早期 diagnostic 与 batch 方案；后续细节由回归/payload 计划覆盖 |
| `docs/chunk-optimization-regression-fix-plan.md` | 施工计划 | 大部分完成 | 覆盖 replacement → overlay、canonical findings |
| `docs/command-output-model-payload-plan.md` | 施工计划 | 部分完成 | 覆盖紧凑 payload、单批和 enrichment |
| `docs/plans/command-output-response-contract-recovery.md` | 施工计划 | **已完成** (2026-06-20) | Round 4 阻断回归；优先于 command-output 后续优化与 parser 收缩 |
| `docs/plans/wingman-mcp-translatebar-report-reliability.md` | 施工计划 | **已完成** (2026-06-28) | TranslateBar 真实报告回归门禁；修复了 xcodebuild 全绿误标 failure、Swift fallback 误导参数、review diff 日期幻觉三类问题；新增 unified diagnostic fields |
| `docs/plans/mcp-tool-feedback-loop.md` | 施工计划 | **已完成** (2026-06-28) | 消费方质量反馈闭环：新增 `aux_report_tool_feedback` 工具、`_meta.trace_id`/`_meta.tool_name` 暴露、聚合脚本、AGENTS 反馈指引 |
| `docs/phase2-tools-validation-plan.md` | 验证战略 | 设计中 | P0 已拆到 `phase2-validation-p0-plan.md` |
| `docs/phase2-validation-p0-plan.md` | 施工计划 | 待实施 | fixtures、expectations、契约和预算测试已存在 |
| `docs/plans/summarize-file-model-first.md` | 施工计划 | 待实施 | 依赖 shared runtime、migration note；纳入 TranslateBar Swift 报告证据 |
| `docs/plans/compress-text-model-first.md` | 施工计划 | 待实施 | 依赖 shared runtime、migration note |
| `docs/plans/review-tools-consolidation.md` | 施工计划 | 待实施 | 优先于 summarize/compress；依赖 canonical diff path |
| `docs/migrations/model-first-output-schema.md` | Migration note | 设计中 | 约束所有公开输出 schema 变更 |
| `docs/plans/npm-publish.md` | 施工计划 | 待实施 | npm 发布配置（bin、files、npx 安装） |

状态只表示当前源码观察结果，不代表已发布版本承诺。实施完成后应更新本表并附验证命令。

## 冲突处理规则

当多份计划修改同一 symbol 时：

1. ADR 与不变量优先；
2. 新施工计划优先于旧概念设计；
3. 先完成依赖计划，再开始下游计划；
4. 不连续实施多个旧方案再重构，直接实现最终目标形态；
5. 计划状态或实现发生变化时更新本地图。

## 公开 API 变更规则

任何 MCP input/output schema 变化必须：

- 在施工计划中列出旧字段与新字段；
- 更新 `docs/migrations/`；
- 同步 `src/schema.ts` 与 `src/index.ts`；
- 添加旧调用方兼容测试；
- 至少保留一个迁移周期再删除旧字段；
- 在 README 中只描述已经实现并验证的行为。

## 完成检查

每份施工计划完成时必须记录：

```text
红灯 fixture：名称与失败证据
GitNexus impact：目标与风险等级
实现 commit 或变更范围
验证命令与结果
detect_changes 结果
migration note 是否更新
计划地图状态是否更新
```
