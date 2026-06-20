# 计划质量评审

基于 `phase2-tools-fix-plan.md` 到 `model-first-all-tools-review-plan.md` 共 7 份设计文档及完整实施过程的回顾。

## 总体评价：中上

前两份是施工图（能直接对着写代码），中间几份是方案设计（需架构决策才能落地），最后一份是概念规划（只定方向不定步长）。

---

## 做得好的

### 1. 问题定位精准

每个计划都从实际使用报告出发，有具体数字：

- "14 个真实错误被拆成 23 个 chunk"
- "模型返回 9/14 条，其余 5 条静默删除"
- "7 个 TS2344 的 line 全部复制为 47"

不是"我们要优化性能"或"需要提高准确性"这种不可验证的表述。每个问题都能在代码里找到对应的行号。

### 2. 验收标准可执行

好的验收标准：

> "TS7053 line 77 和 78 均保留，repeated count 为 2"

差的验收标准（没有出现在这些计划里，但很多团队的文档是这样的）：

> "功能正确"、"用户体验良好"、"性能达标"

### 3. 不变量思维

回归修复计划的核心不是"怎么改代码"，而是定义了 4 组不变量：

- **Canonical finding 不变量**：parser diagnostic → 1:1 canonical finding，总数不因模型响应减少
- **模型禁止覆盖**：file、line、column、error_code、evidence、first_seen_index 来自 parser，模型只能增强 message/confidence/actionability
- **重复项不变量**：重复 diagnostic 保留所有独立位置，不在 canonical 列表中合并
- **统计不变量**：diagnostics_parsed = findings_retained，summary 不使用去重后的数量

不变量 > 架构设计。架构可以推翻重写，只要不变量还在，实现就是正确的。

### 4. 根因分析到位

每个问题追到了代码行级别的根因。例如：

> `split(":")` 解析 `diagnostic_id`，对同文件同错误码场景不安全——7 个 TS2344 每次都匹配到第一条 line 47

这不是泛泛的"映射逻辑有 bug"，可以直接指导修复方案。

### 5. 数据流图清晰

回归修复计划的数据流：

```text
原始输出 → parser → 14 CommandDiagnostic → 14 canonical findings
→ 模型按 diagnostic_id overlay → 仍为 14 → 独立计算重复/排序/建议/summary
```

Payload 优化计划的三层分离：

```text
Diagnostic blocks → Request batches → Model calls
```

全工具评审的共享目标架构：

```text
安全清理 → 确定性结构提取 → 构造 payload → 是否超预算？→ 模型响应校验 → evidence 验证 → 无损聚合 → 状态计算
```

实施时看着这些图就知道当前代码在哪个位置偏离了。

---

## 做得差的

### 1. 计划之间缺少显式依赖声明

回归修复的 P0-4（overlay 模式）和 payload 优化的 P0-2（enrichment 决策）互相依赖，但两份计划各写各的：

- 回归修复改了 `runTscBatchModelPath` 从 replacement → overlay
- Payload 优化又改了同一个函数的 batch 构建逻辑
- Model-first 重构又把这个函数整体替换为 `modelFirstPath`

同一个 `compress-command-output.ts` 被来回改了三遍，每次都要重构前一次的代码。

**应该怎么做**：一份「计划地图」列出各计划间的依赖关系和推荐实施顺序。或者把相关计划合并成一份设计文档，只在实施时按阶段 commit。

### 2. 测试先行缺失

每个计划的回归测试都写在文档末尾，但实施顺序是"先改代码再补测试"：

- 回归修复：先改 `runTscBatchModelPath`，最后才补 fixture expectation
- Payload 优化：先改 `chunkTscErrors`，最后才调整测试期望值

TDD 没有贯彻。实际上补 expectation 的过程中确实暴露了问题（vitest fixture 的 summary 格式不一致），但已经在改完代码之后了。

**应该怎么做**：先写一份「已知问题 → 期望行为」的 fixture expectation，确认它 fail，再改代码让它 pass。这比"改完代码再写测试来验证"更不容易放过回归。

### 3. 全工具评审计划野心太大，落地粒度不够

`model-first-all-tools-review-plan.md` 前 P0/P1 很好——统一 `analysis_status` 和抽取 `model-runtime` 的步骤明确到具体文件和字段。

但 P2-P4 写了 4000 字的目标方向，到具体实施时：

- 每个工具具体改哪几行？
- 哪些 fallback 字段要保留 backward compat，哪些可以直接删？
- heuristic_signals 的 schema 长什么样？
- 幽灵文件消除要改 `splitDiffByFile` 还是 `chunkDiff`？

全部靠实施时现场判断。P0 是施工图，P2-P4 更像概念设计。

**应该怎么做**：要么把 P2-P4 拆成独立的小计划（每个工具一份），要么在概念设计中标出"具体实施步骤待定"。不要用同等密度的文字描述不同粒度的任务。

### 4. 没有迁移策略

所有输出 schema 都新增了字段，但没有说明旧调用方如何兼容：

- `analysis_status` 默认 `"complete"` 保证了 Zod 不抛异常，但调用方看到 `"complete"` 可能错误信任一个纯 heuristic 结果
- `heuristic_signals` 是新增字段，调用方如果不读它，就会漏掉所有非模型审查发现
- `primary_actionable_failure` 和 `first_failure` 语义不同，但没有说明在消费端应该用哪个

**应该怎么做**：每个破坏性 schema 变更附带一份 migration note，说明旧字段的语义变化、新字段的读取优先级、以及一个升级周期内的兼容策略。

---

## 各计划单独评分

| 计划 | 问题定位 | 验收标准 | 实施粒度 | 依赖管理 | 总分 |
|------|:---:|:---:|:---:|:---:|:---:|
| Phase 2 修复方案 | ★★★★ | ★★★★ | ★★★★ | ★★★ | 15/20 |
| 回归修复方案 | ★★★★★ | ★★★★★ | ★★★★ | ★★ | 16/20 |
| Payload 优化方案 | ★★★★ | ★★★★ | ★★★ | ★★ | 13/20 |
| Model-first 命令输出 | ★★★★ | ★★★ | ★★ | ★★ | 11/20 |
| 验证方案 + P0 落地 | ★★★ | ★★★★ | ★★★★ | ★★★ | 14/20 |
| 全工具评审 | ★★★★ | ★★ | ★★ | ★★ | 10/20 |

---

## 改进建议

1. **写「计划地图」**：多份计划时，用一张依赖图标明实施顺序。一份计划内部用 `→` 标注阶段依赖。

2. **先写 expectation 再写代码**：fixture expectation 是最精确的验收标准——写完之后确认它 fail，再改实现。

3. **用不变量替代方案描述**：Plan 的骨架应该是"必须保持的不变量"，具体实现方式可以调整。不变量不会过期。

4. **区分设计文档和施工计划**：概念设计可以说"模型优先、通用分块"，施工计划必须说"在 `chunkTscErrors` 第 84 行把 `MAX_PER_BATCH` 从 8 改成 20"。两种文档混在一起时，实施者需要自己拆任务。

5. **每份计划加 migration note**：只要改了公开 schema，就必须写"调用方需要做什么"。不需要很长，三行就行。
