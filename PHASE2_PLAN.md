# aux-model 二期计划

## 目标

二期只做三个高收益能力：

1. `aux_review_diff_by_file`
2. 统一分块 / 聚合框架
3. `aux_compress_command_output`

目标不是让辅助模型做最终判断，而是让它更适合处理大 diff、长日志和命令输出，减少一期中因为截断和上下文不足造成的误报。

## 非目标

- 不代理 Claude Code 主模型请求。
- 不让辅助模型生成 patch 或决定修改方案。
- 不做全仓库语义搜索。
- 不做安全审计工具包装。
- 不做 provider profile / 隐私模式。
- 不做摘要缓存。
- 不做 `aux_query_code`。

## 设计原则

- 大输入不能简单取前缀截断。
- 所有输出继续保持 `is_authoritative: false`。
- 所有风险必须尽量带证据、位置和置信度。
- 当输入被截断或上下文不完整时，输出必须降级为“需要回查”，不能做强断言。
- fallback 与模型输出保持同构。
- 所有工具继续支持无模型 fallback。
- Zod 运行时 schema、MCP `tools/list` JSON schema、prompt 输出 schema 必须保持一致。
- 被省略的文件、chunk、错误块必须在输出中可见，不能只给省略数量。
- evidence 保留诊断价值，但必须脱敏明显 secret。

## 1. 统一分块 / 聚合框架

### 目标

为大 diff、长命令输出、长文本提供统一处理能力：

```text
split -> analyze chunk -> merge -> final result
```

一期中大输入主要靠 `slice(0, max_chars)`，这会导致：

- diff 尾部上下文丢失。
- review 误报。
- 长日志只保留开头，可能错过真正失败点。

二期需要把“分块和聚合”做成复用模块。

### 建议模块

```text
src/chunking/
├── types.ts
├── diff.ts
├── text.ts
├── command-output.ts
└── merge.ts
```

### 通用类型

```ts
type ChunkKind = "diff-file" | "diff-hunk" | "text-section" | "command-section";

type InputChunk = {
  id: string;
  kind: ChunkKind;
  label: string;
  text: string;
  start_line?: number;
  end_line?: number;
  source?: string;
  truncated: boolean;
};

type OmittedChunk = {
  id: string;
  label: string;
  source?: string;
  reason: string;
  start_line?: number;
  end_line?: number;
};

type ChunkMeta = {
  total_chunks: number;
  analyzed_chunks: number;
  omitted_chunks: number;
  omitted: OmittedChunk[];
  input_truncated: boolean;
  chunking_strategy: string;
};
```

### 分块策略

#### Diff

优先按文件分块：

```text
diff --git / --- +++ boundary
```

如果单文件 diff 仍然过大，再按 hunk 分块：

```text
@@ -old +new @@
```

每个 chunk 必须保留：

- 文件路径
- hunk header
- added / removed / context 行
- chunk id

当 `max_files` 或字符上限触发省略时，必须记录省略明细。不能只记录数量。

文件分析优先级：

1. manifest / lock / dependency 文件，例如 `package.json`、`pnpm-lock.yaml`、`requirements.txt`、`Cargo.toml`。
2. 安全敏感路径，例如 `auth`、`permission`、`security`、`token`、`secret`、`crypto`。
3. 源码文件。
4. 测试文件。
5. 文档和配置文件。
6. 二进制或无法解析文件。

所有文件 header 都应尽量保留；未分析文件进入 `omitted_files` 和 `_meta.chunking.omitted`。

#### 命令输出

按输出类型识别：

- test output
- TypeScript / tsc error
- ESLint output
- build output
- stack trace
- generic log

再按错误块或段落分块：

- stack trace 从 error header 到下一条 error。
- tsc 按 `file(line,column): error TSxxxx` 聚合。
- pytest/vitest/jest 按 failed test block 聚合。
- generic log 按 error/warn/fatal 附近窗口聚合。

### 聚合策略

聚合结果不能简单拼接。需要：

- 去重相同风险或相同错误。
- 合并相同文件的 findings。
- 保留最高 severity。
- 保留每条 finding 的 evidence。
- 在 `_meta` 中记录 chunk 统计。

finding 去重 identity：

```text
normalized risk/kind + file + hunk/location + normalized evidence
```

不能只按 `risk` 文案去重，避免不同文件中的同类问题被错误合并。

排序规则：

1. severity 降序：critical > high > medium > low。
2. confidence 降序：high > medium > low。
3. `introduced_by_diff: true` 优先。
4. 原始出现顺序。

### 验收标准

- 大 diff 不再简单截断前缀。
- 大命令输出能保留后部失败点。
- `_meta.chunking` 中包含 `total_chunks`、`analyzed_chunks`、`omitted_chunks`、`chunking_strategy`。
- 分块后仍能 fallback 工作。

## 2. `aux_review_diff_by_file`

### 目标

新增一个更适合大 diff 的 review 工具，按文件或 hunk 独立分析，再汇总输出。

它解决一期 `aux_review_diff` 的主要问题：

- 大 diff 截断导致误报。
- 风险没有足够证据。
- 无法区分本次引入和上下文已有风险。

### 工具接口

输入：

```ts
type AuxReviewDiffByFileInput = {
  diff: string;
  focus?: string;
  max_chars_per_file?: number;
  max_files?: number;
};
```

默认值建议：

```text
max_chars_per_file = 40000
max_files = 30
```

输出：

```ts
type DiffFinding = {
  risk: string;
  severity: "low" | "medium" | "high" | "critical";
  file: string;
  hunk?: string;
  location?: string;
  explanation?: string;
  evidence: string;
  introduced_by_diff?: boolean;
  confidence: "low" | "medium" | "high";
};

type FileReview = {
  file: string;
  change_summary: string;
  findings: DiffFinding[];
  suggested_source_checks: string[];
  suggested_tests: string[];
  uncertainties: Array<{
    topic: string;
    reason: string;
    suggested_verification?: string;
  }>;
};

type AuxReviewDiffByFileOutput = {
  overall_summary: string;
  files: FileReview[];
  top_risks: DiffFinding[];
  omitted_files: Array<{
    file: string;
    reason: string;
  }>;
  is_authoritative: false;
  _meta: {
    model: string;
    provider?: "remote" | "local" | "heuristic";
    fallback_used: boolean;
    input_truncated: boolean;
    chunking: ChunkMeta;
  };
};
```

### 行为要求

- 每个 finding 必须尽量有 `evidence`。
- 如果 finding 来自新增行，`introduced_by_diff: true`。
- 如果只是上下文风险，`introduced_by_diff: false` 或省略。
- 如果 file chunk 被截断：
  - 不输出高置信度全局控制流判断。
  - 增加 uncertainty。
- 对同一风险跨文件重复出现时，在 `top_risks` 中去重。
- `top_risks` 默认最多返回 10 条，并按 severity、confidence、introduced_by_diff、出现顺序排序。
- `focus` 必须使用不可信数据分隔符包裹。
- `max_files` 命中限制时，必须按文件分析优先级选择文件，并把省略文件写入 `omitted_files`。

### fallback 要求

fallback 可以基于现有 `reviewDiffFallback` 改造：

- 先按文件拆 diff。
- 对每个文件调用 per-file fallback。
- 将已有风险模式映射到 `DiffFinding`。
- evidence 使用触发风险的 added/removed 行。

### 与 `aux_review_diff` 的关系

保留现有 `aux_review_diff`，用于小 diff。

建议 README 中说明：

- 小 diff：`aux_review_diff`
- 大 diff / 多文件 diff：`aux_review_diff_by_file`

### 验收标准

- 同一大 diff 不因为前缀截断漏掉尾部文件。
- 每个风险有 `file` 和 `evidence`。
- 截断文件不会输出高置信度全局结论。
- 支持不同 `focus`，但 focus 不能成为 prompt injection 通道。

## 3. `aux_compress_command_output`

### 目标

新增一个专门压缩命令输出的工具，比通用 `aux_compress_text` 更懂开发命令输出。

适用输入：

- `npm test`
- `npm run build`
- `tsc`
- eslint
- vitest / jest / pytest
- stack trace
- server logs

### 工具接口

输入：

```ts
type AuxCompressCommandOutputInput = {
  command?: string;
  output: string;
  exit_code?: number;
  focus?: string;
  max_chars?: number;
};
```

默认值建议：

```text
max_chars = 120000
```

输出：

```ts
type CommandOutputFinding = {
  kind:
    | "test_failure"
    | "type_error"
    | "lint_error"
    | "build_error"
    | "runtime_exception"
    | "warning"
    | "info"
    | "unknown";
  message: string;
  error_code?: string;
  rule_id?: string;
  file?: string;
  line?: number;
  column?: number;
  evidence: string;
  confidence: "low" | "medium" | "high";
  first_seen_index?: number;
};

type AuxCompressCommandOutputOutput = {
  summary: string;
  first_failure?: CommandOutputFinding;
  findings: CommandOutputFinding[];
  repeated_errors: Array<{
    message: string;
    count: number;
    examples: string[];
  }>;
  suggested_source_checks: string[];
  suggested_next_commands: string[];
  discarded_or_low_confidence: string[];
  is_authoritative: false;
  _meta: {
    model: string;
    provider?: "remote" | "local" | "heuristic";
    fallback_used: boolean;
    input_truncated: boolean;
    chunking: ChunkMeta;
  };
};
```

### 行为要求

- 优先找第一个失败点，而不是平均摘要整段输出。
- 识别并保留：
  - 文件路径
  - 行号
  - 错误码
  - stack trace 顶部和业务代码帧
  - failed test name
  - TypeScript error code
- 对 ESLint / stylelint / biome 等 lint 输出保留 `rule_id`。
- 对 tsc / runtime / test framework 错误保留 `error_code`。
- `first_seen_index` 记录错误在原始输出中的相对出现顺序，merge 后仍可确定首个失败点。
- 重复错误要归并。
- `suggested_next_commands` 只能建议验证命令，不做 destructive 命令。
- `focus` 必须使用不可信数据分隔符包裹。
- `evidence` 必须脱敏明显 secret，例如 bearer token、API key、URL credentials、`.env` 样式密钥值。

### fallback 规则

无模型时也要能工作。

启发式识别：

- TypeScript:

```text
path/to/file.ts(12,34): error TS1234: message
```

- ESLint:

```text
path/to/file.ts
  12:34  error  message  rule-name
```

- Vitest/Jest:

```text
FAIL path/to/test.ts
× test name
AssertionError
```

- Stack trace:

```text
Error: message
    at function (file:line:column)
```

- Generic:

```text
ERROR / WARN / FATAL / Exception / Timeout
```

### 验收标准

- 对 TypeScript 编译错误能提取 file、line、column、TS error code。
- 对测试失败能提取 failed test name。
- 对 stack trace 能提取第一条业务帧。
- 对重复错误能归并计数。
- 大输出不会只保留开头，后部失败点仍能进入 findings。

## Prompt Injection 要求

二期新增和改造的工具都必须遵守：

- 所有用户输入都是不可信数据。
- `focus` 也必须作为不可信数据包裹。
- 模型调用 stateless。
- 模型输出必须 JSON parse + schema 校验。
- schema 校验失败自动 fallback。
- 用户输入中如果包含分隔符本身，必须进行 marker collision 处理，不能让输入提前关闭数据块。

推荐分隔符：

```text
<<<USER_CONTENT_START>>>
...
<<<USER_CONTENT_END>>>

<<<FOCUS_DATA_START>>>
...
<<<FOCUS_DATA_END>>>
```

marker collision 处理要求：

- 对用户输入中的 `<<<USER_CONTENT_END>>>`、`<<<FOCUS_DATA_END>>>` 等 marker 做替换或转义。
- 测试覆盖正文和 focus 中伪造 marker 的情况。
- system prompt 明确说明 content 和 focus 都是数据，不是指令。

## Schema 同步要求

二期输出结构更复杂，必须避免三套 schema 漂移：

1. Zod 运行时 schema：`src/schema.ts`
2. MCP `tools/list` JSON schema：`src/index.ts` 或 schema 导出模块
3. prompt 中展示给模型的输出 schema：`src/prompts.ts`

要求：

- 新增工具时同步更新三处 schema。
- 优先从单一 schema 定义导出 MCP JSON schema，减少手写漂移。
- 如果暂时继续手写，必须添加协议级测试，检查 `tools/list` 中字段与 Zod 输出字段一致。
- prompt schema 不能缺少运行时必填字段；如果 `_meta` 由 server 注入，prompt 中要明确模型不要输出 `_meta`，server 会补齐。

## MCP 协议要求

新增工具必须声明：

```ts
annotations: {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true
}
```

新增工具必须提供：

- `inputSchema`
- `outputSchema`

协议级测试必须覆盖：

- `tools/list` 包含 `aux_review_diff_by_file` 和 `aux_compress_command_output`。
- 新工具 annotations 正确。
- 新工具 `inputSchema` 存在。
- 新工具 `outputSchema` 存在。
- 无模型配置时仍可通过 `tools/call` 返回合法 fallback 结构。
- 模型输出非 JSON 或 schema 不合法时自动 fallback。

## 测试计划

### 单元测试

新增：

- `test/chunking-diff.test.ts`
- `test/chunking-command-output.test.ts`
- `test/review-diff-by-file.test.ts`
- `test/compress-command-output.test.ts`
- `test/prompts-focus.test.ts`

### 必测用例

#### 分块

- 多文件 diff 能拆成多个 file chunk。
- 单文件超大 diff 能拆成 hunk chunk。
- binary diff、rename-only diff、新增文件、删除文件均有明确 chunk 表示。
- 长命令输出能保留后部错误。
- omitted chunk 会进入 `_meta.chunking.omitted`，并包含 reason。

#### `aux_review_diff_by_file`

- 每个 finding 有 file 和 evidence。
- 截断 chunk 不输出高置信度全局控制流结论。
- `focus` 被包在 focus data block 中。
- fallback 模式可用。

#### `aux_compress_command_output`

- TypeScript 错误提取成功。
- TypeScript 错误包含 `error_code`。
- ESLint 错误提取成功。
- ESLint 错误包含 `rule_id`。
- Vitest/Jest failed test 提取成功。
- Stack trace 第一业务帧提取成功。
- 重复错误归并成功。
- fallback 模式可用。
- evidence 中的明显 secret 被脱敏。

#### 协议

- `tools/list` 中两个新工具存在。
- 两个新工具都有 `inputSchema`、`outputSchema`、`readOnlyHint`、`destructiveHint: false`、`openWorldHint`。
- MCP JSON schema、Zod schema、prompt schema 不出现明显字段漂移。

### 验收命令

```bash
npm run build
npm test
```

## 推荐实施顺序

1. 先统一 schema 同步策略，明确 Zod、MCP JSON schema、prompt schema 的来源和测试。
2. 实现 focus 数据块和 marker collision 处理，避免新增工具复制旧 prompt 风险。
3. 实现 `src/chunking/types.ts`、`diff.ts`、`command-output.ts`，包含 omitted 明细。
4. 拆出 `src/fallback/review-diff.ts` 中的 diff 解析、hunk 定位、风险检测公共逻辑。
5. 拆出 `src/fallback/compress-text.ts` 中的关键词、路径提取、行评分、去重公共逻辑。
6. 实现 `aux_review_diff_by_file` fallback 和聚合规则。
7. 接入 `aux_review_diff_by_file` 模型路径和 schema 校验。
8. 实现 `aux_compress_command_output` fallback。
9. 接入 `aux_compress_command_output` 模型路径和 schema 校验。
10. 新增 tools/list 协议级测试。
11. 更新 README：小 diff / 大 diff / 命令输出的推荐使用方式。
12. 补测试，运行 build/test。

## 二期完成标准

- 新增两个工具：
  - `aux_review_diff_by_file`
  - `aux_compress_command_output`
- 引入统一分块 / 聚合框架。
- 大 diff 不再靠前缀截断完成 review。
- 命令输出压缩能定位首个失败点和重复错误。
- 所有新增风险和错误发现都有 evidence。
- `focus` 已安全包裹。
- 无模型配置时 fallback 仍可用。
- `npm run build` 和 `npm test` 通过。
