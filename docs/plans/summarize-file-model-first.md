# `aux_summarize_file` 模型优先施工计划

## 元数据

- 文档类型：施工计划
- 状态：待实施
- 依赖：ADR-0001、shared model-runtime、model-first schema migration
- 公开 schema 变化：可能，仅新增状态/信号字段
- 触发证据：`/Users/jafish/Documents/work/TranslateBar/docs/wingman-mcp-test-report.md`

## 背景

TranslateBar 的 SwiftUI/AppKit 项目测试显示，`aux_summarize_file`
在模型不可用时会进入 heuristic fallback。当前 fallback 只把 `.swift`
识别为 Swift/code 文件，但符号抽取仍依赖通用正则模式；其中
`name(...) {` 规则会把 `VStack`、`Button`、`ScrollView` 等 SwiftUI
组件构造误识别为顶层函数。

这说明问题不只是“缺几条 Swift 正则”，而是工具定位需要收敛：

- 模型路径负责文件语义、职责、重要符号和行为摘要；
- fallback 路径只提供低置信度结构信号；
- fallback 不再伪装成跨语言 parser；
- 新语言支持优先由模型摘要承担，而不是继续堆语言正则。

## 目标

将 `aux_summarize_file` 从“正则跨语言符号提取工具”收敛为
“模型优先的文件摘要工具”。模型可用时优先给出语义摘要；模型不可用
或模型输出失败时，fallback 明确返回 `partial` 结构扫描结果。

## 非目标

- 本阶段不引入 SwiftSyntax、SourceKit 或 tree-sitter-swift；
- 不继续为每门语言维护完整正则 parser；
- 不把模型输出标记为权威结果；
- 不删除现有 MCP tool name；
- 不删除旧输出字段，至少保留一个迁移周期。

## 不变量

- workspace 和路径安全不能弱化；
- 模型负责文件语义、符号角色和行为总结；
- 本地 fallback 不伪装成完整语义摘要；
- 大文件尾部信息不能因截断永久丢失；
- evidence 必须能回查文件内容。
- 所有输出继续保持 `is_authoritative: false`；
- 任何新增字段必须兼容旧调用方。

## Step 0：红灯 fixtures

先增加：

1. 大源码文件，关键导出位于尾部；
2. Markdown 文件，结论位于最后 section；
3. 测试文件，test cases 分布在文件前后；
4. 模型不可用时 `analysis_status = partial`。
5. SwiftUI 文件，包含 `struct View: View`、`VStack`、`Button`、
   `ScrollView`，确认旧 fallback 会误识别 SwiftUI 组件为函数；
6. Swift 服务类文件，包含 `@MainActor final class`、
   `ObservableObject`、`async throws func`，确认模型路径能识别语义职责；
7. TypeScript 文件，确认 TS fallback 的既有结构摘要不被误伤。

确认旧实现无法完整覆盖尾部语义或状态契约后再修改 handler。

## 输出契约

### 模型路径

模型路径用于语义摘要，输出语义为：

- `analysis_status`：`complete` 或 `partial`；
- `_meta.fallback_used`：`false`；
- `summary`：模型生成的文件职责摘要；
- `important_symbols`：模型识别的重要符号，非权威；
- `important_sections` / `test_cases` / `covered_behaviors`：按文件类型可选；
- `evidence`：必须指向可回查源码片段、声明、section 或行号线索；
- `uncertainties`：必须列出不确定点、截断影响和需要人工回查的内容；
- `must_verify_in_source`：`true`；
- `is_authoritative`：`false`。

### fallback 路径

fallback 路径用于结构扫描，输出语义为：

- `analysis_status`：永远为 `partial`；
- `_meta.fallback_used`：`true`；
- `summary`：结构扫描摘要，不承诺语义完整；
- `important_symbols`：保留兼容，但只能表示“可能的声明”；
- 可新增 `heuristic_signals`：`imports`、`line_counts`、
  `possible_declarations`、`file_kind`、`truncation`；
- `uncertainties`：明确说明 fallback 不做语言 AST 解析；
- 对非 TypeScript/JavaScript 语言降低符号置信度。

## 实施步骤

1. 对 `handleSummarizeFile`、`tryModelSummarization`、
   `buildFallbackResult` 和 `summarizeFileFallback` 运行 upstream impact；
2. 固定 Step 0 红灯 fixtures，先确认 SwiftUI 误报和 fallback partial
   语义缺口；
3. 使用共享 execution/status metadata，统一模型路径与 fallback 路径的
   `_meta` 和 `analysis_status`；
4. 小文件保持一次模型调用；
5. 超预算文件按可回查区段分批，保留文件前缀和后缀，避免尾部声明丢失；
6. 分段结果通过模型做最终归并；
7. 调整 prompt，要求模型输出 evidence、uncertainties，并禁止把
   DSL 组件调用当作顶层声明；
8. 验证模型 evidence/section 能在原文件定位；
9. 将 regex fallback 输出降级为 structural signals；
10. 停止新增完整语言 symbol regex；如需 Swift 短期防误报，只做降低
    错误置信度的过滤，不把 fallback 扩展成 Swift parser；
11. 保持旧输出字段一个迁移周期；
12. 更新 README、迁移说明和使用建议。

## Migration

- 原 `summary` 保留；fallback summary 必须配合 `analysis_status = partial`；
- 可新增 `heuristic_signals`，不能替代 `important_symbols`；
- 模型路径的 `important_symbols` 仍是非权威结果。
- 旧调用方继续可以读取 `important_symbols`；
- 新调用方应优先读取 `analysis_status`、`_meta.fallback_used` 和
  `heuristic_signals` 判断结果可靠性；
- README 只能描述已经实现并验证的行为。

## 风险

- 模型路径增加 token 成本和延迟；
- 模型输出需要更严格 schema validation，否则会频繁回退；
- fallback 降级后，模型不可用环境的信息量会减少；
- 新增 optional 字段需要同步 schema、测试和文档；
- 若 prompt 约束不足，模型仍可能把 SwiftUI DSL 当作业务符号。

## 回滚

- 保留原 `important_symbols` 字段，避免旧调用方立刻失败；
- 如果模型路径稳定性不足，保留 fallback-only 行为作为临时开关；
- 如果 `heuristic_signals` 契约不稳定，先不在 README 宣称该字段；
- 任何 schema 变更都可以通过 optional 字段回滚，不删除旧字段。

## 验收

- [ ] 尾部关键结构进入模型摘要。
- [ ] 模型不可用时不会返回 complete。
- [ ] 新语言不需要新增 regex。
- [ ] SwiftUI fallback 不再把 `VStack`、`Button`、`ScrollView` 等组件
      当作高置信度顶层函数。
- [ ] Swift 模型路径能总结 `struct View`、`@MainActor class`、
      `async throws func` 的职责和关键行为。
- [ ] TS/JS fallback 既有 smoke 测试保持通过。
- [ ] 新增 optional 字段通过 schema validation。
- [ ] 旧调用方字段兼容测试通过。
- [ ] 路径穿越与绝对路径测试保持通过。
- [ ] build、test、smoke、detect_changes 通过。

## 验证命令

```bash
npm test
npm run smoke
npm run build
```

实施完成前还必须运行：

```text
detect_changes()
```

并在本计划中记录受影响 symbols、execution flows 和风险等级。
