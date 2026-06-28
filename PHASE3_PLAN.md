# Wingman 三期方向草案

## 文档状态

- 类型：战略设计草案
- 状态：设计中
- 前置条件：二期模型响应契约恢复和真实回放已完成
- 上位约束：`docs/adr/0001-model-first.md`

本文件只确定三期方向、状态摘要和后续专项计划链接，不作为可直接施工的计划。接口、Schema、字段方案、目标 symbols、迁移方案、Step 0 证据和完成定义留到下一轮专项计划。

## 三期主题

三期从“单输入压缩工具”升级为“多证据协同与可持续评测”：

```text
先建立可重复验证的模型能力
再收敛现有工具入口
最后增加少量高价值的新用户能力
```

不以增加工具数量或支持更多专用格式为目标。

## 推荐优先级

### P0：Schema 单一来源

目标：消除 Zod runtime schema、MCP `tools/list` JSON schema 和 prompt schema 的手工漂移。

方向：

- 以一套 schema 定义作为事实来源；
- 自动生成或校验 MCP input/output schema；
- 增加协议级契约测试；
- 新增字段时不再要求多处手工同步。

### P0：自动回放评测平台

目标：在进入真实项目前发现模型、Prompt、Schema、聚合和调用预算回归。

方向：

- 使用匿名化真实 fixtures；
- 支持模型、Prompt 和配置的批量回放；
- 记录 finding 召回、evidence 验证、状态、调用次数、token、延迟和 fallback；
- 使用不变量和门禁判断通过或失败；
- 保存脱敏汇总，不默认保存完整用户输入或模型响应。

### P1：收敛 diff 工具入口

目标：减少调用方在 `aux_review_diff` 与 `aux_review_diff_by_file` 之间做选择。

方向：

- `aux_review_diff` 根据最终 payload 预算自动选择单次或按文件/hunk 分批；
- 复用统一 evidence、状态和 omitted tracking；
- 保留旧入口完成兼容迁移；
- 验证稳定后再评估是否废弃独立的 by-file 入口。

### P1：新增 `aux_compare_runs`

目标：比较修复前后两次测试、构建或运行输出，判断问题是否解决以及是否引入新回归。

接口字段、状态语义和 evidence 规则由后续 `aux_compare_runs` 专项计划定义。

定位边界：只比较和压缩证据，不自动修改代码，不声称给出权威根因。

### P2：候选 `aux_summarize_bundle`

目标：联合压缩调用方明确提供的多个文件、diff 和日志，形成带来源引用的上下文包。

限制：

- 不自行扫描整个仓库；
- 不替代代码图谱和符号依赖分析；
- 每条结论必须引用具体 artifact；
- 必须记录被省略或未分析的输入；
- 是否实施由 P0 评测数据和真实使用需求决定。

## 推荐实施顺序

```text
1. Schema 单一来源与 tools/list 契约测试
2. 自动回放评测平台与发布门禁
3. diff 工具入口收敛
4. aux_compare_runs
5. 根据真实数据决定 aux_summarize_bundle
```

如果三期资源有限，优先完成：

```text
自动回放评测平台 + aux_compare_runs
```

## 暂不推荐

- 为 Jest、Vitest、Webpack、Vite 等继续新增专用完整 parser；
- 自动生成或应用修复 patch；
- 新增另一种 diff review 工具；
- 通用代码搜索或全仓库语义查询；
- 没有评测数据支撑的缓存、provider profile 或复杂路由；
- 把辅助模型结果升级为权威审计结论。

## 下次具体设计需要确认

1. 三期资源范围和预期交付周期；
2. P0 是先做 Schema 单一来源还是评测平台；
3. `aux_compare_runs` 是否只支持命令输出，还是支持通用 artifact；
4. diff 工具兼容窗口和废弃策略；
5. fixture 的采集、匿名化、版本管理和门禁阈值；
6. token、延迟和最大模型调用次数的目标；
7. 是否将真实模型评测纳入本地命令、CI 或发布前人工门禁。

## 进入施工前的输出物

下次具体设计完成后，应拆分为：

- ADR 或现有 ADR 补充；
- P0 评测平台施工计划；
- Schema 单一来源迁移计划；
- diff 工具收敛施工计划；
- `aux_compare_runs` 独立施工计划；
- 对应 migration note、失败 fixtures 和完成定义。
