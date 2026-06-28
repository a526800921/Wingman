# `aux_compress_text` 模型优先施工计划

## 元数据

- 文档类型：施工计划
- 状态：待实施
- 依赖：ADR-0001、shared model-runtime、model-first schema migration
- 公开 schema 变化：可能，仅新增状态/信号字段

## 不变量

- 模型负责语义压缩和 focus 判断；
- 本地关键词只能作为 extracted signals；
- 长文本尾部根因不能因截断丢失；
- 部分 batch 失败必须返回 partial；
- summary 不能把未分析区段表达成已覆盖。

## Step 0：红灯 fixtures

先增加：

1. 根因位于日志末尾；
2. focus 只命中文本后半段；
3. 混合中英文长文本；
4. 一个 batch 失败、其他 batch 成功；
5. 模型不可用时 fallback 状态为 partial。

## 实施步骤

1. 对 `handleCompressText` 运行 upstream impact；
2. 使用共享 payload 预算判断是否分批；
3. 小文本保持一次调用；
4. 长文本按段落/通用日志块分批；
5. 使用模型归并分段摘要；
6. 记录未分析和低置信度区段；
7. 将关键词评分 fallback 改为 extracted signals；
8. 保持旧 `summary`、`key_facts` 字段兼容。

## Migration

- `summary` 和 `key_facts` 保留；
- fallback 结果必须标记 partial/incomplete；
- 新增 signals 时调用方只作为回查线索。

## 验收

- [ ] 尾部根因进入最终摘要。
- [ ] focus 后半段命中不会丢失。
- [ ] 小输入一次模型调用。
- [ ] 部分失败状态和 omitted 范围可见。
- [ ] build、test、smoke、detect_changes 通过。
