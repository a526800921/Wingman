# 架构精简：幽灵模块清理、Schema 去重、Handler 样板消除

## 元数据

- 文档类型：施工计划
- 状态：已完成 (2026-06-28)
- 依赖计划：无（独立执行，不依赖其他计划）
- 相关 ADR：`docs/adr/0001-model-first.md`
- 公开 schema 变化：否（行为不变，仅内部组织方式变化）
- Migration note：无（公开契约不变）

## 1. 问题与证据

2026-06-28 架构评审（`/improve-codebase-architecture`）发现三类结构性问题：

### 幽灵模块：model-runtime 中 3 个文件全仓库零消费

```
src/model-runtime/execution.ts  — 0 imports（rg 搜索确认，GitNexus 也无法索引）
src/model-runtime/batching.ts   — 0 imports
src/model-runtime/evidence.ts   — 0 imports
```

这些文件设计为「共享模型执行/批处理/evidence 校验层」，但从未被任何工具 handler 导入。每个 handler 都内联实现了自己的模型调用、批处理和 evidence 校验逻辑。CLAUDE.md 推荐实施顺序第 9 步已将「收缩旧 heuristic 语义代码」列入。

此外 `types.ts` 中 3/5 的类型（`EvidenceVerdict`、`ModelExecutionMeta`、`BatchSpec`）仅被上述幽灵模块引用，可从 types.ts 安全删除。

### Schema 双重定义：index.ts 585 行手工 JSON Schema 与 schema.ts Zod 重复

CLAUDE.md 明确记录：「`src/index.ts` 的 tool output JSON schema 与 `src/schema.ts` 的 Zod schema 手工重复，schema drift 是已知风险」。

已确认的 drift：`_meta.chunking` 字段在 `review-diff-by-file` 的 JSON Schema 中是详细对象，在 `compress-command-output` 的 JSON Schema 中仅为 `{ type: "object" }`，但在 schema.ts 中两者都使用 `ChunkMetaSchema`。

### Handler 样板代码：5 个工具，4 种配置判断实现

| Handler | 配置判断函数 | ConfigLike 类型 |
|---------|------------|----------------|
| summarize-file | `isFullConfig()` | 参数类型 |
| compress-text | 内联 `isFullConfig` | 内联 |
| review-diff | `hasApiKey()` | `type ConfigLike` |
| review-diff-by-file | `hasApiKey()` | `type ConfigLike` |
| compress-command-output | `hasApiKey()` | `type ConfigLike` |

此外 `sanitizeEvidence()` 在 `tools/compress-command-output.ts` 和 `fallback/compress-command-output.ts` 中独立定义（相同实现）；`isBinaryFile()` + `BINARY_EXTENSIONS` 在 `chunking/diff.ts` 和 `fallback/review-diff.ts` 中完全重复。

## 2. 必须保持的不变量

- 所有 MCP tool 的 input/output schema 公开契约不变
- `npm test` 全部通过
- `npm run build` 零错误
- 所有工具输出的 `is_authoritative: false` 和 `_meta` 语义不变
- 不引入新的「共享框架」导致幽灵模块问题重演（Step 2 只提取实用工具函数，不做 handler 高阶函数）

## 3. 范围

### 包含

- 删除 `execution.ts`、`batching.ts`、`evidence.ts` 三个零消费文件
- 精简 `types.ts`（从 5 个类型缩减到 2 个）
- 用 `zod-to-json-schema`（已安装依赖）从 Zod schema 生成 JSON Schema，替换 `index.ts` 中 585 行手工定义
- 提取 `src/shared/config-guard.ts`（统一 `ConfigLike` + `hasApiKey`）
- 提取 `src/shared/handler-boilerplate.ts`（统一 trace 创建 + `_meta` 组装）
- 提取 `src/shared/sanitize.ts`（统一 `sanitizeEvidence`）
- 消除 `isBinaryFile` 重复（fallback/review-diff.ts 改为从 chunking/diff.ts 导入）

### 不包含

- review-diff 与 review-diff-by-file 的 fallback 模式检测去重（由已有专项计划 `review-tools-consolidation` 覆盖）
- 建立完整的 handler 高阶函数（当前各 handler 的 model 调用差异过大，强行统一会导致耦合）
- 修改任何 MCP tool 的 input/output schema 契约
- compress-command-output.ts 大文件拆分（留待后续专项计划）

## 4. 目标 symbols 与影响分析

| Symbol | 文件 | 预期修改 | GitNexus risk |
|---|---|---|---|
| （文件级） | `src/model-runtime/execution.ts` | 删除 | 零消费者，安全 |
| （文件级） | `src/model-runtime/batching.ts` | 删除 | 零消费者，安全 |
| （文件级） | `src/model-runtime/evidence.ts` | 删除 | 零消费者，安全 |
| `AnalysisStatus`, `ModelSkipReason` | `src/model-runtime/types.ts` | 保留，移至 status.ts 或保留精简版 | 仅被 status.ts 使用 |
| `EvidenceVerdict`, `ModelExecutionMeta`, `BatchSpec` | `src/model-runtime/types.ts` | 删除 | 仅被幽灵模块使用 |
| TOOL_DEFINITION 常量 | `src/index.ts` | outputSchema 改为从 schema.ts 导入 | tools/list 响应变化 |
| `isFullConfig`/`hasApiKey`/`ConfigLike` | `src/tools/*.ts` ×5 | 改为从 shared/config-guard 导入 | handler 内部实现 |
| `sanitizeEvidence` | `src/tools/compress-command-output.ts`、`src/fallback/compress-command-output.ts` | 改为从 shared/sanitize 导入 | 内部实现 |
| `isBinaryFile` | `src/fallback/review-diff.ts` | 改为从 chunking/diff.ts 导入 | 内部实现 |

## 5. Step 0：先建立红灯测试

本计划是清理性重构（内部组织变化，行为不变），Step 0 基线为：现有测试套件全部通过。如果在修改过程中任何测试失败，即表示违反了不变量。

### 基线确认

```text
运行命令：npm test && npm run build
当前结果：待运行（实施前执行）
```

### 专项验证（Step 1）

对 `tools/list` 进行前后对比：修改前后 `outputSchema` JSON 字段结构和类型应等价。

```text
运行命令：git diff src/index.ts  # 人工审查 outputSchema 变化
验证标准：字段路径、类型、required 列表一致
```

## 6. 目标数据流

### Step 0（删除幽灵模块）

```text
删除前: src/model-runtime/{execution,batching,evidence,types}.ts (未被导入)
删除后: src/model-runtime/{status,diagnostics,truncation,types}.ts (仅 status 从 types 导入)
```

### Step 1（Schema 去重）

```text
schema.ts (Zod) → zodToJsonSchema() → 生成的 JSON Schema
  → index.ts 导入并引用为 outputSchema
  → MCP tools/list 响应
```

### Step 2（Handler 样板消除）

```text
handler 调用 shared/config-guard (hasApiKey / ConfigLike)
         → shared/handler-boilerplate (createTraceContext / assembleMeta)
         → shared/sanitize (sanitizeEvidence)
  model path: ChatClient → prompt → JSON parse → schema validate → shared meta
  fallback path: heuristic → shared meta
```

## 7. 实施步骤

### Step 0：删除幽灵模块

1. **确认零消费者**
   ```bash
   rg "model-runtime/execution|model-runtime/batching|model-runtime/evidence" src/ test/
   # 必须无结果
   ```
2. **删除 3 个文件**：`src/model-runtime/execution.ts`、`batching.ts`、`evidence.ts`
3. **精简 types.ts**：删除 `EvidenceVerdict`、`ModelExecutionMeta`、`BatchSpec`，保留 `AnalysisStatus` 和 `ModelSkipReason`
4. **验证**：`npm run build && npm test`

### Step 1：消除 Schema 双重定义

1. **在 schema.ts 中新增 `toolOutputJsonSchemas` 导出**
   - 对 5 个工具 output Zod schema 调用 `zodToJsonSchema()`（从已安装的 `zod-to-json-schema` 导入）
   - 导出为 `Record<string, object>` 映射
2. **重写 index.ts 的 tool definitions**
   - 删除 L35-619 的手工 JSON Schema 常量（`SUMMARIZE_FILE_OUTPUT_SCHEMA` 等）
   - 各 tool definition 的 `outputSchema` 改为 `toolOutputJsonSchemas["aux_summarize_file"]` 等
   - 保留 `inputSchema` 手工定义（简短且不易漂移）
3. **验证**：`npm run build && npm test`，并人工审查 `tools/list` 响应不变

### Step 2：提取共享 Handler 模式

1. **创建 `src/shared/config-guard.ts`**
   - 统一的 `ConfigLike` 类型
   - 统一的 `hasApiKey()` 函数
2. **创建 `src/shared/handler-boilerplate.ts`**
   - `createTraceContext(toolName)` —— 封装 `createTraceId` + `createTraceMeta` + `traceLogger`，返回 `{ tid, traceMeta, log }`
   - `assembleBaseMeta(params)` —— 封装 `buildDiagnosticMeta` + `traceMeta` + 基础字段（provider/model/tokens/input_truncated/fallback_used），接受 tool-specific 的 `overrides` 扩展
3. **创建 `src/shared/sanitize.ts`**
   - 提取 `sanitizeEvidence()`，`tools/compress-command-output.ts` 和 `fallback/compress-command-output.ts` 改为导入
4. **在 5 个 handler 中采用共享模块**
   - 逐个替换，每次替换后运行测试确认通过
5. **消除 isBinaryFile 重复**
   - `fallback/review-diff.ts` 从 `chunking/diff.ts` 导入 `isBinaryFile`，删除本地版本
6. **验证**：`npm run build && npm test`

## 8. Schema Migration

无。本计划不改变任何 MCP tool 的 input/output 契约。`tools/list` 返回的 outputSchema JSON 结构保持等价。

## 9. 回滚策略

- 整个计划可分 Step 独立回滚（每个 Step 是一个 git commit）
- 无数据库或持久化状态变化
- 每个 Step 完成后 `npm test` 必须通过，未通过则在该 Step 内修复
- 回滚到任一步骤前只需 `git revert` 对应 commit

## 10. 验证

```bash
npm run build                      # TypeScript 编译零错误
npm test                           # 全部测试通过
npm run smoke                      # smoke tests 通过
rg "model-runtime/execution|model-runtime/batching|model-runtime/evidence" src/  # 无结果（Step 0）
rg "function isBinaryFile" src/ --type ts  # 只有 chunking/diff.ts 一处定义（Step 2）
rg "function sanitizeEvidence" src/ --type ts  # 只有 shared/sanitize.ts 一处定义（Step 2）
rg "isFullConfig\|hasApiKey(" src/tools/ --type ts  # 只有 shared/config-guard 的 import（Step 2）
detect_changes                     # 仅预期文件受影响
```

## 11. 完成定义

- [ ] 红灯基线确认：`npm test && npm run build` 在开始前通过。
- [ ] Step 0：3 个幽灵文件已删除，types.ts 已精简，build + test 通过。
- [ ] Step 1：index.ts 中 585 行手工 JSON Schema 已替换为 zod-to-json-schema 生成，build + test 通过，MCP tools/list 输出等价。
- [ ] Step 2：`src/shared/` 下 3 个新文件已创建，5 个 handler 已采用，2 处重复函数已统一，build + test 通过。
- [x] `detect_changes` 仅包含预期文件。
- [x] `docs/PLAN_MAP.md` 已更新。
- [x] 完成证据已写回本计划。

## 完成证据

- Step 0 基线确认：修改前 `npm test` 352 pass, 0 fail；`npm run build` 通过。
- Step 0 完成：3 个幽灵文件已删除，types.ts 从 47 行 5 类型缩减到 20 行 2 类型。model-runtime/ 从 7 文件缩减到 4 文件。
- Step 1 完成：index.ts 从 775 行缩减到 239 行（-69%），585 行手工 JSON Schema 替换为 `zod-to-json-schema` 自动生成。
- Step 2 完成：3 个 shared 模块创建（config-guard.ts, handler-boilerplate.ts, sanitize.ts）。5 个 handler 统一使用共享模块。sanitizeEvidence 和 isBinaryFile 重复已消除。
- 全部测试通过：362 tests, 352 pass, 0 fail, 10 skipped。
- 项目 TS 总行数：10,663 → 9,882（-781 行，-7.3%）。

## 测试覆盖率

现有测试套件覆盖全部修改文件。无新测试添加（本计划为纯重构，行为不变）。
- `test/schema-analysis-status.test.ts` 验证 output schema 一致性（Step 1 关键验证）。
- `npm run smoke` 通过。
