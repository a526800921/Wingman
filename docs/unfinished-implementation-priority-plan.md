# 未完成项优先级实施计划

本文件是未完成工作排序索引，只记录推荐顺序、状态摘要和专项计划链接。计划状态、依赖、阻塞项和证据链接以 `docs/PLAN_MAP.md` 为事实源；实施范围、Step 0、字段方案、完成条件和验证命令以各专项计划为事实源。

## 总体顺序

| 顺序 | 优先级 | 项目 | 状态摘要 | 专项计划或证据 |
|---:|---|---|---|---|
| 1 | P0 | TranslateBar 真实报告可靠性 | 已完成；后续 summarize/review 迁移仍受该真实报告约束 | `docs/plans/wingman-mcp-translatebar-report-reliability.md` |
| 2 | P0.5 | 反馈引导与可复现性增强 | 已完成；从未完成队列移出 | `docs/plans/feedback-guidance-reproducibility.md` |
| 3 | P2 | shared model-runtime 与 mock model 测试 | 待拆为专项施工计划；当前仍由战略设计跟踪 | `docs/model-first-all-tools-review-plan.md` |
| 4 | P3 | review_diff / review_diff_by_file 收敛 | 待实施 | `docs/plans/review-tools-consolidation.md` |
| 5 | P4 | summarize_file 模型优先迁移 | 待实施 | `docs/plans/summarize-file-model-first.md` |
| 6 | P5 | compress_text 模型优先迁移 | 待实施 | `docs/plans/compress-text-model-first.md` |

## 已移出未完成队列

| 项目 | 状态摘要 | 专项计划 |
|---|---|---|
| analysis_status 与 schema migration 语义统一 | 已完成 (2026-06-28) | `docs/plans/unify-analysis-status.md` |
| npm publish | 已完成 (2026-06-28) | `docs/plans/npm-publish.md` |

## 使用规则

- 修改排序、状态摘要或阻塞项时，同步 `docs/PLAN_MAP.md`。
- 修改实施范围、字段方案、Step 0、完成条件或验证结果时，同步对应专项计划，并让本索引只保留摘要和链接。
- 验收本文件时，用 `rg` 搜索 P 编号、计划名、状态名和关键字段，确认没有复制专项计划细节。
