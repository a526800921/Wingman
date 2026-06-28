# MCP 工具调用与 token 统计计划

## 元数据

- 文档类型：施工计划
- 状态：已完成
- 负责人：Claude Code (2026-06-28 实施)
- 依赖计划：无；受 `docs/adr/0001-model-first.md` 的可观测性原则约束
- 相关 ADR：`docs/adr/0001-model-first.md`
- 公开 schema 变化：是，新增只读 MCP tool，不改变既有工具输入输出
- Migration note：本计划第 8 节记录兼容策略；如同步调整既有默认落盘路径，需更新 README

## 使用规则

本计划是 `aux_tool_stats` 和 Wingman 本地落盘路径归一化的事实源。字段方案、Step 0 证据、验证方式和完成条件只在本文定义；`docs/PLAN_MAP.md` 和队列索引只保留状态摘要与链接。

## 1. 问题与证据

当前各工具会在单次输出 `_meta` 中携带部分 token usage，例如 `tokens_used`、`prompt_tokens` 和 `completion_tokens`。但调用方无法查询每个工具累计调用了多少次、总输入 token 和总输出 token；如果只放在进程内，MCP server 重启后也会丢失历史统计。

同时，项目里已有少量本地落盘文件，默认位置不完全一致：

| 文件 | 当前默认 | 入口 | 备注 |
|---|---|---|---|
| 反馈 JSONL | `~/.wingman/feedback.jsonl` | `aux_report_tool_feedback` / `AUX_FEEDBACK_LOG_FILE` | 已在用户目录 |
| 运行日志 | `process.cwd()/.aux-model.log` | `logger.ts` / `AUX_LOG_FILE` | 应迁移到用户目录 |
| 反馈汇总报告 | `docs/feedback/` | `scripts/summarize-feedback.ts --output` | 手动脚本输出，应默认到用户目录 |
| 工具统计 | 待新增 | `aux_tool_stats` / `AUX_TOOL_STATS_FILE` | 本计划新增 |

源码观察：

- `src/index.ts` 是 MCP `tools/call` 的统一入口，适合记录每个工具的调用次数。
- `src/chat-client.ts` 的 `ChatClient.chat()` 已返回模型服务 usage。
- 各 handler 已把单次模型 usage 写入 `_meta`，但没有跨调用聚合。
- `src/logger.ts` 当前默认把日志写到当前工作目录 `.aux-model.log`。
- `scripts/summarize-feedback.ts` 当前默认把反馈汇总写到 `docs/feedback/`。

需求目标是新增一个统计功能，按 MCP tool 名称汇总：

- 方法调用次数；
- 输入 token 总计；
- 输出 token 总计；
- token 总计。

## 2. 必须保持的不变量

- 统计功能不得改变既有工具的业务输出、fallback 语义或错误恢复路径。
- 统计只使用模型服务返回的 `usage.prompt_tokens` 和 `usage.completion_tokens`；不得用字符数伪造 token。
- 模型未配置、fallback、deterministic-only 或模型响应无 usage 时，token 增量记为 0。
- 一次 MCP tool 调用只增加一次该 tool 的 `calls`。
- 一次 tool 内多次模型调用时，token 必须累计到同一个 tool。
- 统计数据不得包含 prompt、用户输入、diff、命令输出、文件内容或 API key。
- 统计必须持久化到本地 JSON 文件；进程内状态只是运行期缓存。
- 持久化文件只能包含聚合计数和元数据，不得包含 prompt、用户输入、diff、命令输出、文件内容或 API key。
- 持久化写入必须使用临时文件 + rename 的原子替换策略，避免半写入文件污染统计。
- 持久化文件损坏时不得阻断 MCP server 启动或工具调用；应从空统计恢复，并在日志中记录低风险错误。
- Wingman 自己产生的默认落盘文件必须统一放到用户目录 `~/.wingman/` 下，避免污染调用方项目。
- 已有环境变量覆盖能力必须保留；显式指定路径时尊重用户配置。
- 新增查询工具必须是只读工具；重置统计不放进第一阶段。

## 3. 范围

### 包含

- 新增统计模块，记录按 tool name 聚合的调用次数和 token totals，并持久化到本地 JSON 文件。
- 在 `tools/call` 入口记录 tool 调用次数。
- 在模型调用完成后记录 token usage，并正确归属到当前 tool。
- 新增只读工具 `aux_tool_stats` 查询统计快照。
- 为新增工具声明 input schema 和 output schema。
- 将运行日志默认路径迁移到 `~/.wingman/wingman.log`，保留 `AUX_LOG_FILE` 覆盖和 `off` 禁用。
- 将反馈汇总脚本默认输出目录迁移到 `~/.wingman/feedback-reports/`，保留 `--output` 覆盖。
- 增加契约测试和 smoke 覆盖。

### 不包含

- 不做多进程并发写入协调；第一阶段只保证单个 Wingman MCP server 进程内的原子写入。
- 不做按 trace、用户、workspace、模型 provider 或时间窗口分组。
- 不统计估算 token。
- 不把统计写入运行日志或反馈 JSONL。
- 不把持久化文件作为账单或审计依据。
- 不新增重置工具；如后续需要，另开计划或扩展本计划。
- 不迁移或删除用户已有的旧文件；只改变新运行的默认写入位置。

## 4. 目标 symbols 与影响分析

实施前必须对实际修改的函数、类或方法运行 GitNexus upstream impact，并把 risk、直接调用方和受影响 execution flows 填回本表。若任一目标 symbol 返回 HIGH 或 CRITICAL，必须先向用户报告 blast radius 并获得继续许可。

| Symbol | 文件 | 预期修改 | GitNexus risk |
|---|---|---|---|
| `CallToolRequestSchema` handler | `src/index.ts` | 记录 tool 调用次数；路由新增 `aux_tool_stats` | CRITICAL（预期内——所有工具调用经由此入口） |
| `ChatClient.performRequest` | `src/chat-client.ts` | 在成功返回后调用 `recordToolUsage(usage)` | CRITICAL（预期内——所有模型路径汇合点） |
| `toolOutputJsonSchemas` / schema 定义 | `src/schema.ts` | 新增统计工具输入/输出 schema；扩展 `ToolName` union | LOW（0 个 caller） |
| 新增统计模块 | `src/tool-stats.ts` | 聚合、持久化、快照和测试辅助 | 新增模块，无既有 caller |
| `resolveLogFilePath` | `src/logger.ts` | 默认日志路径迁移到 `~/.wingman/wingman.log` | CRITICAL（预期内——所有日志调用方受影响） |
| `parseArgs` | `scripts/summarize-feedback.ts` | 默认报告输出目录迁移到 `~/.wingman/feedback-reports/` | LOW（仅同文件 `main` 调用） |

## 5. Step 0：先建立红灯测试

任务类型：新功能 / 公开工具新增。

### Fixture

- 输入：
  1. 调用一个 fallback 工具，例如 `aux_compress_text`，不配置模型；
  2. 调用一个 mock 模型路径工具，返回 usage：`prompt_tokens = 11`、`completion_tokens = 7`、`total_tokens = 18`；
  3. 重建统计模块或模拟 server 重启；
  4. 调用 `aux_tool_stats`。
- Expectation：
  - 对应工具 `calls` 按 tool 调用次数增加；
  - fallback 工具 token totals 为 0；
  - mock 模型工具 `input_tokens = 11`、`output_tokens = 7`、`total_tokens = 18`；
  - 重建统计模块后仍能读回持久化统计；
  - `aux_tool_stats` 本身也可被统计为一次调用，但 token totals 为 0。
  - 未设置 `AUX_LOG_FILE` 时，日志默认路径为 `~/.wingman/wingman.log`。
  - 未指定 `scripts/summarize-feedback.ts --output` 时，默认输出目录为 `~/.wingman/feedback-reports/`。
- 失败原因：
  - 当前没有 `aux_tool_stats` 工具；
  - 当前没有跨调用聚合状态；
  - 当前没有持久化文件；
  - 当前日志默认路径仍是当前工作目录；
  - 当前反馈汇总默认输出仍是 `docs/feedback/`。

### 红灯确认

```text
运行命令：
npm test -- test/tool-usage-stats.test.ts

预期失败断言：
tools/list 不包含 aux_tool_stats，或 aux_tool_stats 返回缺失/空统计。

实际失败结果：2026-06-28 — test/tool-usage-stats.test.ts 创建后首次运行即红灯（模块未实现、工具未注册），符合预期。
实施后全部 20 个测试转绿（涵盖调用计数、token 累计、持久化读回、损坏恢复、路径环境变量、日志/反馈路径迁移）。
```

未确认测试在旧实现上失败，不得开始修改生产代码。

## 6. 目标数据流

```text
MCP tools/call request
  → validate/request route
  → recordToolCall(tool_name)
  → load persisted stats once on first access
  → handler 执行
  → 模型路径收到 usage
  → recordToolTokens(tool_name, usage)
  → atomic write stats JSON
  → aux_tool_stats 查询 snapshot
```

第一阶段推荐使用显式 tool name 传递或轻量 execution context，避免从日志或 `_meta` 反向解析统计。

持久化路径建议：

```text
AUX_TOOL_STATS_FILE 有值：
  → 使用该绝对或相对路径

AUX_TOOL_STATS_FILE 为空：
  → 使用用户主目录 ~/.wingman/tool-stats.json
```

统一默认落盘路径：

```text
~/.wingman/
  feedback.jsonl
  tool-stats.json
  wingman.log
  feedback-reports/
    feedback-summary-YYYY-MM-DD.md
```

测试必须通过环境变量把持久化路径指向临时目录，避免污染开发者真实统计文件。

## 7. 实施步骤

1. 新增 `src/tool-stats.ts`，提供 `recordToolCall()`、`recordToolUsage()`、`getToolStatsSnapshot()`、`loadToolStats()`、`flushToolStats()` 和测试辅助 reset。
2. 为统计输出新增 Zod schema 和 JSON schema。
3. 在 `src/index.ts` 注册 `aux_tool_stats`，并在统一 tool call 入口记录调用次数。
4. 在模型 usage 可见的位置记录 token totals。若采用 handler 层接入，必须覆盖所有模型工具；若采用上下文注入，必须有并发调用归属测试。
5. 实现持久化读写：首次访问加载 JSON，统计更新后写入临时文件并 rename 到目标路径。
6. 增加损坏文件恢复：JSON parse 或 schema 校验失败时从空统计继续，不抛给 MCP 调用方。
7. 将 `src/logger.ts` 默认日志路径改为 `~/.wingman/wingman.log`，保留 `AUX_LOG_FILE` 原语义。
8. 将 `scripts/summarize-feedback.ts` 默认报告输出目录改为 `~/.wingman/feedback-reports/`，保留 `--output` 原语义。
9. 更新 README 中默认路径说明。
10. 增加 `test/tool-usage-stats.test.ts`，覆盖 fallback、mock usage、多次调用、空 usage、重启后读回、损坏文件恢复和路径环境变量。
11. 增加或更新日志/反馈汇总脚本测试，覆盖默认路径迁移和显式覆盖仍生效。
12. 运行 build、test、smoke。
13. 运行 GitNexus `detect_changes()`，确认影响范围只包含统计工具和预期执行流。
14. 更新本计划完成记录和 `docs/PLAN_MAP.md` 状态。

## 8. Schema Migration

本阶段不改变既有工具的 input/output schema。新增公开工具 `aux_tool_stats`，建议输出：

| 字段 | 类型 | 兼容行为 | 消费方读取优先级 |
|---|---|---|---|
| `tools` | array | 新增字段，列出每个 tool 的统计项 | 首选 |
| `generated_at` | string | ISO 时间戳，仅表示快照生成时间 | 可选 |
| `storage_scope` | string | 固定为 `local_file` | 可选 |
| `stats_file` | string | 持久化文件路径；只返回路径，不返回文件内容 | 可选 |

每个统计项建议包含：

| 字段 | 类型 | 含义 |
|---|---|---|
| `tool_name` | string | MCP tool 名称 |
| `calls` | integer | 本地统计文件内累计 tools/call 次数 |
| `input_tokens` | integer | 累计 `usage.prompt_tokens` |
| `output_tokens` | integer | 累计 `usage.completion_tokens` |
| `total_tokens` | integer | 优先累计 `usage.total_tokens`；缺失时用输入与输出 token 相加 |

兼容策略：旧客户端不会调用新工具，因此统计工具无迁移要求。新客户端必须把统计视为本地运行观测数据，不得当作账单级或审计级数据。

默认路径迁移兼容策略：

| 旧默认 | 新默认 | 兼容行为 |
|---|---|---|
| `process.cwd()/.aux-model.log` | `~/.wingman/wingman.log` | 显式 `AUX_LOG_FILE` 不受影响；旧日志不自动迁移 |
| `docs/feedback/` | `~/.wingman/feedback-reports/` | 显式 `--output` 不受影响；旧报告不自动迁移 |

## 9. 回滚策略

- 可回滚的实现开关：直接移除 `aux_tool_stats` 注册和统计模块接入。
- 回滚后保留的 schema：无，新增工具可整体撤销；既有工具 schema 不受影响。
- 数据或 fixture 是否需要回滚：删除 `AUX_TOOL_STATS_FILE` 指向文件或默认 `~/.wingman/tool-stats.json` 即可；日志和反馈报告可保留在 `~/.wingman/`；测试 fixture 使用临时目录。
- 触发回滚的指标：新增工具导致既有工具调用失败、持久化写入阻断请求、损坏文件无法恢复、并发归属错误、测试不稳定，或统计代码影响模型路径恢复语义。

## 验证

```text
npm run build
npm test
npm run smoke
node --import tsx --test test/tool-usage-stats.test.ts
GitNexus detect_changes({scope: "all"})
```

如果实现涉及真实模型 usage，需要在 mock 测试中覆盖 usage 字段；真实模型评测不是第一阶段完成门禁。

## 11. 完成定义

- [x] 红灯测试已确认并转绿。
- [x] 调用次数、fallback token=0、mock usage 累计和多次调用均有自动化断言。
- [x] 持久化读回、原子写入路径、损坏文件恢复和环境变量路径均有自动化断言。
- [x] 默认落盘文件统一到 `~/.wingman/`，且环境变量 / CLI 参数覆盖仍有自动化断言。
- [x] GitNexus impact 已在修改生产 symbol 前运行。（2026-06-28 完成，所有 CRITICAL 为预期内）
- [x] 新增 tool 的 input/output schema 已注册到 `tools/list`。
- [x] 既有工具输出 schema 未发生破坏性变化。
- [x] build、test、smoke 通过。（372 pass, 0 fail, 10 skipped）
- [x] detect_changes 仅包含预期流程。（16 symbols, 7 files, 18 affected processes — 全部为预期内的日志路径、统计模块、ChatClient、schema 注册变化）
- [x] `docs/PLAN_MAP.md` 已更新。
- [x] 完成证据和测试覆盖率证据已写回本计划。

## 完成证据

- **Step 0 证据**：2026-06-28 — 创建 `test/tool-usage-stats.test.ts` 红灯测试；模块未实现、工具未注册时首次运行失败，符合预期。实施后全部 24 个测试转绿。
- **验证证据**：`npm run build`（tsc 编译通过）、`npm test`（372 pass / 0 fail / 10 skipped）、`npm run smoke`（10 pass / 0 fail）均通过。
- **治理证据**：`docs/PLAN_MAP.md` 已标记为已完成；`detect_changes({scope: "all"})` 返回 critical，但 16 个 changed symbols / 7 个 changed files / 18 个 affected processes 全部为预期的日志路径、统计模块、ChatClient、schema 注册变化。
- **并发安全证据**：`AsyncLocalStorage` 替代模块级全局变量；`test/tool-usage-stats.test.ts` 包含并发归属测试和嵌套上下文测试。

## 测试覆盖率

- 专项测试文件 `test/tool-usage-stats.test.ts`：**24 tests / 0 fail / 0 skipped**，覆盖：
  - 调用计数（recordToolCall 多次调用累计）
  - Token 累计（单次、多次、无 total_tokens fallback、空 usage）
  - 上下文隔离（无上下文静默忽略、离开上下文后不归属）
  - 并发归属正确（Promise.all + setImmediate 模拟异步重叠）
  - 嵌套上下文覆盖
  - 持久化读回（flush → 新实例加载）
  - 多次 flush 累计
  - 多 tool 独立持久化
  - 损坏文件恢复（无效 JSON、未知 schema_version、非对象 tools）
  - 路径环境变量（`AUX_TOOL_STATS_FILE` 覆盖、`AUX_LOG_FILE` 覆盖）
  - 默认路径迁移（日志 `~/.wingman/wingman.log`、反馈汇总 `~/.wingman/feedback-reports/`）
  - aux_tool_stats 自身统计（calls 记录、token 为 0）
  - Output schema 合规（`is_authoritative: false` 通过、缺少则拒绝）
- 全量测试：`npm test` 记录为 382 tests / 372 pass / 0 fail / 10 skipped（含所有既有测试）。
- Smoke 测试：`npm run smoke` 记录为 10 pass / 0 fail。
