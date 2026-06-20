# Diff Review 工具模型优先收敛施工计划

## 元数据

- 文档类型：施工计划
- 状态：Ready
- 依赖：ADR-0001、shared model-runtime、model-first schema migration
- 涉及工具：`aux_review_diff`、`aux_review_diff_by_file`
- 公开 schema 变化：是，需兼容期

## 不变量

- 小 diff 只调用一次模型；
- 大 diff 超预算后才按 canonical file/hunk 分批；
- `a/`、`b/` 和模型返回路径不能产生重复文件；
- 空 preamble 不能成为文件；
- heuristic pattern 只能产生 signals；
- 正式 risk 必须有 diff evidence；
- 未分析文件必须出现在 omitted/partial 状态中。

## Step 0：红灯 fixtures

先增加：

1. 两文件 diff，旧实现产生 5 个幽灵文件；
2. 小型多文件 diff，应只调用一次模型；
3. 一个文件多个 hunks；
4. `/dev/null` 新增和删除文件；
5. 正则表面命中但上下文安全的误报；
6. 模型 evidence 不在 diff 中；
7. 部分 batch 失败。

## 目标 symbols

- `splitDiffByFile`
- `chunkDiff`
- `handleReviewDiff`
- `handleReviewDiffByFile`
- `aggregateByFile`
- `reviewDiffFallback`
- `reviewDiffByFileFallback`

修改前分别运行 upstream impact。

## 实施步骤

1. 建立 canonical diff path，统一去除 `a/`、`b/` 并处理 `/dev/null`；
2. 空 preamble 仅作为元数据，不生成 FileSection；
3. 文件身份由本地 canonical path 决定，模型 file 仅用于校验；
4. 将“小输入一次调用、超预算才分批”下沉到共享 execution；
5. `review_diff` 大输入调用相同的 file/hunk 分批策略；
6. heuristic risk 降级为 `heuristic_signals`；
7. 正式 findings 通过 evidence 验证；
8. 保持 `review_diff_by_file` 兼容入口一个迁移周期；
9. 评测稳定后将其标记 deprecated，最终由 `review_diff` 自动选择策略。

## Migration

- `aux_review_diff` 原字段保持；大输入开始返回 partial/omitted 信息；
- `aux_review_diff_by_file` 暂不删除；
- heuristic signals 不再直接计入 possible risks/top risks；
- 调用方应优先使用 `aux_review_diff`，仅在兼容期显式调用 by-file 工具。

## 回滚

- 保留 by-file 入口作为执行策略回滚点；
- canonical path 修复不可回滚为重复文件行为；
- 如果模型分批召回率下降，可临时恢复旧路由，但保留状态与 evidence 校验。

## 验收

- [ ] 两个真实文件只产生两个 file entries。
- [ ] 小型多文件 diff 只有一次模型调用。
- [ ] 大 diff 无静默截断。
- [ ] heuristic signal 不冒充正式 risk。
- [ ] 无 evidence 模型结论被降级。
- [ ] by-file 兼容入口仍可用。
- [ ] build、test、smoke、detect_changes 通过。
