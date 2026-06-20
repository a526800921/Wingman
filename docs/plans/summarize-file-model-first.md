# `aux_summarize_file` 模型优先施工计划

## 元数据

- 文档类型：施工计划
- 状态：Ready
- 依赖：ADR-0001、shared model-runtime、model-first schema migration
- 公开 schema 变化：可能，仅新增状态/信号字段

## 不变量

- workspace 和路径安全不能弱化；
- 模型负责文件语义、符号角色和行为总结；
- 本地 fallback 不伪装成完整语义摘要；
- 大文件尾部信息不能因截断永久丢失；
- evidence 必须能回查文件内容。

## Step 0：红灯 fixtures

先增加：

1. 大源码文件，关键导出位于尾部；
2. Markdown 文件，结论位于最后 section；
3. 测试文件，test cases 分布在文件前后；
4. 模型不可用时 `analysis_status = partial`。

确认旧实现无法完整覆盖尾部语义或状态契约后再修改 handler。

## 实施步骤

1. 对 `handleSummarizeFile` 运行 upstream impact；
2. 使用共享 execution/status metadata；
3. 小文件保持一次模型调用；
4. 超预算文件按可回查区段分批；
5. 分段结果通过模型做最终归并；
6. 验证模型 evidence/section 能在原文件定位；
7. 将 regex fallback 输出降级为 structural signals；
8. 停止新增语言 symbol regex；
9. 保持旧输出字段一个迁移周期。

## Migration

- 原 `summary` 保留；fallback summary 必须配合 `analysis_status = partial`；
- 可新增 `heuristic_signals`，不能替代 `important_symbols`；
- 模型路径的 `important_symbols` 仍是非权威结果。

## 验收

- [ ] 尾部关键结构进入模型摘要。
- [ ] 模型不可用时不会返回 complete。
- [ ] 新语言不需要新增 regex。
- [ ] 路径穿越与绝对路径测试保持通过。
- [ ] build、test、smoke、detect_changes 通过。
