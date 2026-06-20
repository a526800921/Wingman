# 施工计划模板

> 本模板用于可直接实施的施工计划。战略设计和 ADR 不应伪装成施工计划。

## 元数据

- 文档类型：施工计划
- 状态：Draft / Ready / In Progress / Complete / Superseded
- 负责人：
- 依赖计划：
- 相关 ADR：
- 公开 schema 变化：是 / 否
- Migration note：

## 1. 问题与证据

描述真实输入、实际输出和可复现数字。必须引用 fixture、报告或源码证据，避免“提升体验”等不可验证描述。

## 2. 必须保持的不变量

列出不随实现变化的正确性约束。

## 3. 范围

### 包含

- ...

### 不包含

- ...

## 4. 目标 symbols 与影响分析

| Symbol | 文件 | 预期修改 | GitNexus risk |
|---|---|---|---|
| ... | ... | ... | 待运行 |

不得把固定行号作为长期定位依据；使用 symbol 和当前文件路径。

## 5. Step 0：先建立红灯测试

### Fixture

- 输入：
- Expectation：
- 失败原因：

### 红灯确认

```text
运行命令：
预期失败断言：
实际失败结果：实施时填写
```

未确认测试在旧实现上失败，不得开始修改生产代码。

## 6. 目标数据流

```text
输入
  → ...
  → 输出
```

## 7. 实施步骤

每一步应包含目标 symbol、输入输出变化、不变量、对应测试和阶段依赖。

## 8. Schema Migration

如果没有公开 schema 变化，明确写“无”。如果存在变化，至少说明：

| 旧字段 | 新字段 | 兼容行为 | 消费方读取优先级 |
|---|---|---|---|
| ... | ... | ... | ... |

并更新 `docs/migrations/`。

## 9. 回滚策略

- 可回滚的实现开关：
- 回滚后保留的 schema：
- 数据或 fixture 是否需要回滚：
- 触发回滚的指标：

## 10. 验证

```text
npm run build
npm test
npm run smoke
专项 fixture / 模型评测命令
gitnexus_detect_changes
```

## 11. 完成定义

- [ ] 红灯测试已确认并转绿。
- [ ] 所有不变量有自动化断言。
- [ ] GitNexus impact 已在修改前运行。
- [ ] 公开 schema 已有 migration note。
- [ ] 失败、部分失败和预算路径已覆盖。
- [ ] build、test、smoke 通过。
- [ ] detect_changes 仅包含预期流程。
- [ ] `docs/PLAN_MAP.md` 已更新。
