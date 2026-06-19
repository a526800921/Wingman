# Wingman

Claude Code 的僚机 MCP server。像僚机飞在侧翼负责侦察和提醒——做摘要、压缩和 diff 初筛，确保不遗漏明显检查项。结果非权威，主 agent 做最终决策。

## 定位

```
主模型 = 资深工程师做 code review，能看深层设计和架构问题
Wingman = junior 拿着 checklist 逐项打勾——"你确认了 X 吗？有没有漏 Y？"
```

不替代你的判断，而是确保你的判断路径上没有遗漏明显的检查项。

## 工具

| 工具 | 用途 |
|------|------|
| `aux_summarize_file` | 摘要源码/文档/测试文件。自动识别文件类型，按类型输出不同结构 |
| `aux_compress_text` | 压缩日志、错误栈、长文档。适合 >1000 字符的长文本 |
| `aux_review_diff` | 对 unified diff 做提交前 checklist 式审查。像 junior 逐项打勾，确保不遗漏检查项 |

## 使用场景

### ✅ 推荐场景

| 场景 | 工具 |
|------|------|
| 长日志 / 错误栈快速定位 | `aux_compress_text` + `focus` |
| 大 diff 提交前 checklist 式扫描 | `aux_review_diff` |
| 测试文件提取 test_cases 和 covered_behaviors | `aux_summarize_file`（测试文件） |
| 不熟悉的大文件快速了解结构 | `aux_summarize_file` |
| 多视角审视同一改动 | `aux_review_diff` + 不同 `focus` |

### ❌ 不推荐场景

| 场景 | 原因 |
|------|------|
| 小文件 < 50 行 | 直接读更高效 |
| compress 短文本 < 1000 字符 | 压缩产生不了边际收益 |
| 最终 review 决策 | 结果非权威，有 30% 误报率 |
| 精确符号依赖的重构 | 符号提取可能不完整 |
| 安全审计 | 辅助模型不可信 |

## 安全说明

- 所有工具的 `openWorldHint` annotation 表示输出可能不完整。
- 输出中 `is_authoritative` 永远为 `false`，`must_verify_in_source` 永远为 `true`。
- Claude Code 在编辑、执行 shell 命令、删除文件或做架构决策前**必须**直接回查原文。
- 文件访问限制在 `AUX_WORKSPACE_ROOT` 目录内，拒绝路径穿越。
- prompt injection 多层防护：内容分隔符 + FOCUS_DATA 独立包裹 + stateless 调用 + JSON-only 约束 + schema 校验。

## 安装

```bash
cd E:\work\mcp-local
npm install
npm run build
```

## 配置

### 1. 编辑 `.env`

```env
AUX_MODEL_BASE_URL=https://api.deepseek.com/v1
AUX_MODEL_NAME=deepseek-v4-flash
AUX_MODEL_TIMEOUT_MS=30000
AUX_MODEL_ALLOWED_HOSTS=api.deepseek.com
AUX_LOG_FILE=E:\work\mcp-local\.aux-model.log
AUX_MODEL_API_KEY=你的key
```

### 2. 注册到 Claude Code

```powershell
# 项目级（仅当前项目可用）
claude mcp add -s project wingman -- node E:\work\mcp-local\dist\index.js

# 全局（所有项目可用）
claude mcp add -s user wingman -- node E:\work\mcp-local\dist\index.js
```

`AUX_WORKSPACE_ROOT` 不需要设置——自动取当前项目目录。

### 3. 验证

```powershell
claude mcp list
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AUX_MODEL_API_KEY` | 是* | — | API key（不写入 .mcp.json） |
| `AUX_MODEL_BASE_URL` | 否 | `https://api.deepseek.com/v1` | OpenAI-compatible API 地址 |
| `AUX_MODEL_NAME` | 否 | `deepseek-v4-flash` | 模型名称 |
| `AUX_MODEL_PROVIDER` | 否 | `remote` | 模型来源（remote / local） |
| `AUX_MODEL_TIMEOUT_MS` | 否 | `30000` | 请求超时（毫秒） |
| `AUX_MODEL_ALLOWED_HOSTS` | 否 | — | 允许的 API host（逗号分隔） |
| `AUX_WORKSPACE_ROOT` | 否 | 当前目录 | 文件访问根目录 |
| `AUX_ALLOW_INSECURE_LOCAL_HTTP` | 否 | `false` | 允许本地 http（仅 loopback） |
| `AUX_LOG_LEVEL` | 否 | `info` | 日志级别（debug/info/warn/error） |
| `AUX_LOG_FILE` | 否 | `.aux-model.log` | 日志文件路径，设 `off` 禁用 |

\* 不配置 API key 时，所有工具自动使用**启发式 fallback**，仍然可用。

## 日志

所有日志写入 stderr + 本地文件。默认文件为当前项目下的 `.aux-model.log`，可通过 `AUX_LOG_FILE` 自定义。每条日志含 trace ID 和耗时：

```
[WINGMAN][INFO][...] [a1b2c3d4] summarize_file start {"path":"src/foo.ts"}
[WINGMAN][INFO][...] [a1b2c3d4] chat request completed {"usage":{"total_tokens":1905}}
[WINGMAN][INFO][...] [a1b2c3d4] summarize_file done — 7985ms
```

## 开发

```bash
npm install
npm run build        # tsc 编译
npm run dev          # tsx 直接运行
npm test             # 运行测试（53 条）
npm run smoke        # 冒烟测试（不依赖 API key）
```

覆盖率：78.55% 行覆盖，安全关键路径（workspace/schema/fallback）>90%。

## 项目结构

```
src/
├── index.ts              # MCP server 入口
├── config.ts             # 环境变量读取
├── chat-client.ts        # OpenAI-compatible HTTP client（HTTPS/SSRF/超时/重试）
├── workspace.ts          # 路径安全解析（8 层 Windows 加固）
├── schema.ts             # 输入/输出 Zod schema
├── prompts.ts            # Stateless prompt 构造 + 反注入
├── logger.ts             # stderr + 文件日志（trace ID + 耗时）
├── fallback/
│   ├── summarize-file.ts # 启发式文件摘要（按文件类型输出不同结构）
│   ├── compress-text.ts  # 启发式文本压缩
│   └── review-diff.ts    # 启发式 diff review
└── tools/
    ├── summarize-file.ts # aux_summarize_file handler
    ├── compress-text.ts  # aux_compress_text handler
    └── review-diff.ts    # aux_review_diff handler
```

## 兼容性

- Node.js >= 18
- OpenAI-compatible Chat API（DeepSeek、Ollama、LM Studio、vLLM、llama.cpp 等）
- Windows / macOS / Linux

## License

MIT
