# TranslateBar 回归修复验收补齐建议

## 背景

`docs/plans/wingman-mcp-translatebar-report-reliability.md` 已标记为已完成，但验收复核发现仍有若干完成定义没有被实现或没有证据支撑。

本建议用于补齐该计划的验收缺口，不扩大原计划范围。

## 当前验收结论

不通过。

已通过：

- `node --import tsx --test test/translatebar-report-reliability.test.ts`：10/10 通过。
- `npm test`：0 fail，10 skipped。
- `npm run build`：通过。
- `npm run smoke`：10/10 通过。

未通过：

- xcodebuild 全绿 fixture 没有产生 `test_success` 语义。
- 成功场景 `first_failure` 被省略，不是固定 `null`。
- 专项测试允许 `first_failure.kind = "test_success"`，与计划要求冲突。
- `src/index.ts` MCP output schema 未同步 `test_success` / `build_success` 和统一诊断字段。
- `docs/migrations/model-first-output-schema.md` 未记录 2026-06-28 schema 变更。
- 计划第 4 节 GitNexus impact 表仍为 `待运行`。
- `detect_changes(scope: "compare", base_ref: "HEAD~1")` 返回 `critical`，不能直接视为“只包含预期流程”。

## 修复目标

让实现、测试、公开 schema、migration note 和治理证据全部满足 `wingman-mcp-translatebar-report-reliability.md` 的完成定义。

## 1. 修正 command-output 成功语义

### 当前问题

对 `test/fixtures/command-output/xcodebuild-success-136-tests.txt` 调用 `aux_compress_command_output`，实际输出类似：

```json
{
  "summary": "Detected \"generic_log\". Parsed 0 diagnostics...",
  "findings": [],
  "_meta": {
    "detector_hint": "generic_log"
  }
}
```

问题：

- 没有 `test_success`。
- `first_failure` 被 `JSON.stringify` 省略，不是 `null`。
- `detector_hint` 仍是 `generic_log`。

### 建议改法

在 command-output detector / fallback 派生逻辑中识别强成功信号：

```text
TEST SUCCEEDED
** TEST SUCCEEDED **
0 failures
All tests passed
BUILD SUCCEEDED
```

测试成功输出建议生成：

```json
{
  "findings": [
    {
      "kind": "test_success",
      "message": "All tests passed",
      "evidence": "TEST SUCCEEDED — 136 tests, 0 failures",
      "confidence": "high"
    }
  ],
  "first_failure": null,
  "primary_actionable_failure": null
}
```

构建成功输出使用 `build_success`。

### Schema 要求

`first_failure` 和 `primary_actionable_failure` 必须支持：

```text
CommandOutputFinding | null
```

不要只依赖 optional 字段省略。

## 2. 修正专项测试

### 当前问题

`test/translatebar-report-reliability.test.ts` 目前接受：

```json
{
  "first_failure": {
    "kind": "test_success"
  }
}
```

这与计划要求冲突。成功场景下 `first_failure` 应固定为 `null`。

### 建议断言

直接调用 handler 跑 fixture：

```text
test/fixtures/command-output/xcodebuild-success-136-tests.txt
```

断言：

```ts
assert.equal(data.findings[0].kind, "test_success");
assert.equal(data.first_failure, null);
assert.equal(data.primary_actionable_failure, null);
assert.notEqual(data._meta.detector_hint, "generic_log");
```

并保留 schema 验证：

```ts
assert.equal(validateOutput("aux_compress_command_output", data).ok, true);
```

## 3. 同步 runtime schema 和 MCP output schema

### 当前问题

`src/schema.ts` 已加入部分字段，但 `src/index.ts` 的 MCP output schema 仍存在旧枚举和旧 `_meta` 字段。

需要同步：

- `kind` enum 增加：

```text
test_success
build_success
```

- `first_failure` / `primary_actionable_failure` 支持：

```text
object | null
```

- `_meta` 增加：

```text
model_used
analysis_mode
confidence
limitations
```

短期可以手动同步 `src/index.ts`；后续应考虑让 MCP schema 生成或复用 `src/schema.ts`，避免继续漂移。

## 4. 补充 migration note

在 `docs/migrations/model-first-output-schema.md` 增加小节：

```text
## 2026-06-28: TranslateBar 报告回归修复

- `CommandOutputFinding.kind` 新增 `test_success` / `build_success`。
- 成功场景 `first_failure` / `primary_actionable_failure` 为 `null`。
- `_meta` 新增 `model_used`、`analysis_mode`、`confidence`、`limitations`。
- 消费方应先判断 success kind，再读取 failure 字段。
```

兼容策略：

```text
旧调用方忽略新增 kind 时，至少不能把 success kind 当 failure。
```

## 5. 补 GitNexus 证据或撤回完成状态

### 当前问题

计划第 4 节 impact 表仍为 `待运行`，但完成定义已经勾选 impact 和 detect_changes。

复核命令：

```text
detect_changes(scope: "compare", base_ref: "HEAD~1")
```

结果：

```text
risk_level: critical
changed_count: 32
affected_count: 62
changed_files: 15
```

这需要解释和记录，不能直接视为“只包含预期流程”。

### 建议处理

二选一：

1. 补证据：把实际 impact / detect_changes 结果写回计划，包括 `critical` 的原因、影响流程和是否可接受。
2. 撤回完成状态：把计划状态从 `已完成` 改回 `实施中`，等证据补齐后再完成。

## 6. 验证清单

修复后运行：

```bash
node --import tsx --test test/translatebar-report-reliability.test.ts
npm test
npm run build
npm run smoke
```

GitNexus：

```text
detect_changes(scope: "compare", base_ref: "HEAD~1")
```

如果已新增一个补丁提交，建议同时运行：

```text
detect_changes(scope: "compare", base_ref: "HEAD~2")
```

前者看补丁范围，后者看整个计划范围。

## 建议实施顺序

1. 修 command-output handler 行为和专项测试断言。
2. 同步 `src/index.ts` MCP output schema。
3. 补 `docs/migrations/model-first-output-schema.md`。
4. 补计划里的 GitNexus impact / detect_changes 证据，或撤回完成状态。
