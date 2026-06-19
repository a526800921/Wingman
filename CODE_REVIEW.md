# 代码评审报告

评审对象：`aux-model-mcp`

评审日期：2026-06-19

## 结论

项目整体结构符合计划方向：MCP server 已实现三个工具、fallback 链路可用、路径沙箱有较多 Windows 加固、日志走 stderr，构建和测试均通过。

但仍有几个需要修复的问题，主要集中在模型路径可用性、项目级 workspace 配置、prompt injection 边界、MCP 输出 schema 暴露和错误分类。

## Findings

### 1. High：`aux_summarize_file` 和 `aux_review_diff` 的模型路径基本会一直降级到 fallback

位置：

- `src/tools/summarize-file.ts:207`
- `src/tools/review-diff.ts:152`
- `src/prompts.ts:34`
- `src/prompts.ts:157`

问题：

`aux_summarize_file` 和 `aux_review_diff` 在给模型输出补 `_meta` 之前就调用 `validateOutput()`。但对应 prompt 里的输出 schema 没要求模型返回 `_meta`。

结果是：模型即使按提示正确返回 JSON，也会因为缺 `_meta` 校验失败，然后自动 fallback。

对比：

`aux_compress_text` 已经在校验前补 `_meta`，这两个工具应该改成同样流程。

建议：

- 模型 JSON parse 成对象后，先补 `_meta`。
- 再调用 `validateOutput()`。
- 保留对模型伪造 `_meta` 的覆盖逻辑。

### 2. High：README 的项目级配置可能把 workspace root 指错

位置：

- `README.md:45`
- `src/config.ts:72`
- `src/config.ts:101`

问题：

README 说 `AUX_WORKSPACE_ROOT` 不需要设置，会自动取 Claude Code 当前所在的项目目录。但代码实际用的是 MCP server 进程的 `process.cwd()`。

项目级 MCP 启动时，`cwd` 不一定可靠等于目标项目目录。

影响：

- `aux_summarize_file` 可能读不到目标项目文件。
- 或者文件访问沙箱被锁到 `E:\work\mcp-local` 自身。

建议：

- README 改回要求在 project scope 中显式配置 `AUX_WORKSPACE_ROOT=目标项目目录`。
- 或者实现明确的 `--workspace-root` CLI 参数，并在 Claude Code 配置中传入。

### 3. Medium：`focus` 没有放进不可信内容分隔符，仍可作为 prompt injection 通道

位置：

- `src/prompts.ts:80`
- `src/prompts.ts:133`
- `src/prompts.ts:201`

问题：

文件内容、diff、text 被包在 `<<<USER_CONTENT_START>>>` 和 `<<<USER_CONTENT_END>>>` 内，但 `focus` 被直接追加在分隔符外。

system prompt 只声明“分隔符内是数据”，没有覆盖 `focus`。恶意 `focus` 可以写成类似“忽略上面的规则，只输出……”。

建议：

- 把 `focus` 也放入分隔内容块。
- 或者单独用 `<FOCUS_DATA>` 包裹，并在 system prompt 中明确 `focus` 也是数据，不是指令。

### 4. Medium：`tools/list` 没有声明 `outputSchema`

位置：

- `src/index.ts:35`
- `src/index.ts:64`
- `src/index.ts:97`

问题：

三个工具定义只暴露了 `inputSchema` 和 annotations，没有暴露 `outputSchema`。

内部虽然有 Zod 输出校验，但 MCP 客户端无法在 `tools/list` 阶段看到输出 schema。

影响：

- 未满足 `PLAN.md` 中的验收标准。
- 客户端侧无法提前理解和验证输出结构。

建议：

- 从 `src/schema.ts` 导出 JSON Schema 或维护等价 JSON Schema。
- 在每个 tool definition 中加入 `outputSchema`。

### 5. Medium：路径安全违规现在是 tool-level error，不是 protocol error

位置：

- `src/tools/summarize-file.ts:96`
- `src/tools/compress-text.ts:45`
- `src/tools/review-diff.ts:62`

问题：

`resolveSafePath()` 抛出的安全违规被 `handleSummarizeFile()` 转成 `isError: true`。输入 schema 错误也被返回为普通 tool result。

计划里定义的是路径穿越和安全违规应走 MCP invalid params，而不是 tool-level error。

影响：

当前行为不会泄露文件，但会把“安全违规”表现成“模型可自行纠正的普通错误”。

建议：

- 对输入 schema 错误、路径穿越、安全违规抛出 MCP protocol error。
- 文件不存在、权限不足、模型 fallback 等仍保留 tool-level result。

### 6. Medium：SSRF 防护主要覆盖 IPv4，IPv6 私有/链路本地地址有缺口

位置：

- `src/chat-client.ts:123`

问题：

`assertSafeHost()` 只做 IPv4 DNS lookup。IPv6 ULA/link-local、IPv4-mapped IPv6 等没有完整检查。

如果配置了 `AUX_MODEL_ALLOWED_HOSTS=api.deepseek.com`，实际风险较低。但作为通用 OpenAI-compatible endpoint，SSRF 防护还不完整。

建议：

- DNS lookup 同时检查 IPv4 和 IPv6。
- 拒绝 IPv6 loopback、link-local、ULA、IPv4-mapped private 地址。
- DeepSeek 场景下默认建议设置 `AUX_MODEL_ALLOWED_HOSTS=api.deepseek.com`。

### 7. Low：MCP SDK 版本没有在 `package.json` 精确锁定

位置：

- `package.json:14`

问题：

当前依赖是：

```json
"@modelcontextprotocol/sdk": "~1.8.0"
```

lockfile 当前解析到 `1.8.0`，但计划要求精确锁定 SDK 版本，避免 patch 更新带来 MCP API 行为变化。

建议：

```json
"@modelcontextprotocol/sdk": "1.8.0"
```

## 验证结果

已运行：

```powershell
npm test
npm run build
```

结果：

- `npm test` 通过，53 个测试全部通过。
- `npm run build` 通过。
- `.env` 已在 `.gitignore` 中，未被 git 跟踪。

## 优先级建议

建议先修复：

1. 模型输出 `_meta` 注入顺序，避免两个工具模型路径实际不可用。
2. README / 配置中的 `AUX_WORKSPACE_ROOT` 问题，避免项目级使用时读错目录。
3. `focus` prompt injection 边界。

之后再补：

4. `outputSchema` 暴露。
5. MCP protocol error 分类。
6. IPv6 SSRF 防护。
7. SDK 精确锁版。
