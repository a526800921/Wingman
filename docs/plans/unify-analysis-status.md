# 统一 analysis_status 与 Schema Migration 语义

## 元数据

- 文档类型：施工计划
- 状态：已完成 (2026-06-28)
- 依赖计划：`docs/plans/wingman-mcp-translatebar-report-reliability.md`、`docs/plans/mcp-tool-feedback-loop.md`
- 相关 ADR：`docs/adr/0001-model-first.md`
- 公开 schema 变化：是
- Migration note：`docs/migrations/model-first-output-schema.md`

## 1. 问题与证据

6 个具体问题详见 `docs/unfinished-implementation-priority-plan.md` P1 节。核心问题：
- 4 个输出 schema 有 `default("complete")`，handler 忘记设置时静默填完整
- `index.ts` JSON schema 漂移 7-11 个 `_meta` 字段
- 2 个工具的 `_meta` 未复用 `ResultMetaSchema`
- 3 个 handler 未使用 `modelPathStatus`/`fallbackStatus` 共享辅助

## 2. 必须保持的不变量

- 所有工具输出 `is_authoritative: false`
- 所有 `_meta` 可选字段保持可选
- 5 个工具 `_meta` 均基于 `ResultMetaSchema`
- 顶层 `analysis_status` 为主读取位
- 无运行时行为变更（除 1 处 correctness fix）

## 3. 实施步骤

1. 移除 4 处 `.default("complete")`（`src/schema.ts`）
2. `ReviewDiffByFileOutput._meta` → `ResultMetaSchema.extend({})`
3. `CompressCommandOutputOutput._meta` → `ResultMetaSchema.extend({})`
4. 同步 5 个 JSON schema（`src/index.ts`）
5. 3 个 handler 改用 `modelPathStatus`/`fallbackStatus`
6. 新增 `test/schema-analysis-status.test.ts`（21 tests）
7. 更新 migration doc 和 PLAN_MAP

## 4. 验证

```bash
npm run build                  # 通过
npm test                       # 346 pass, 0 fail
npm run smoke                  # 通过
grep 'default("complete")' src/schema.ts  # 无结果
grep -c ResultMetaSchema src/schema.ts     # 7
detect_changes                  # 仅预期流程受影响
```

## 5. 完成证据

- 红灯 fixture：`test/schema-analysis-status.test.ts` 确认 `analysis_status` 缺失时 Zod reject
- GitNexus impact：21 changed symbols, 42 affected processes（全部为预期的 handler 及调用链）
- Implementation commits：(见 git log)
- `docs/PLAN_MAP.md` 已更新
- `docs/migrations/model-first-output-schema.md` 已更新
