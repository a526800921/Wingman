# npm 发布施工计划

## 元数据

- 文档类型：施工计划
- 状态：已完成 (2026-06-28)
- 负责人：-
- 依赖计划：无
- 相关 ADR：无
- 公开 schema 变化：否
- Migration note：无

## 1. 问题与证据

**现状**：用户必须手动 clone 仓库、`npm install`、`npm run build` 才能使用 Wingman。MCP 注册命令依赖本地绝对路径：

```bash
claude mcp add -s project wingman -- node /absolute/path/to/dist/index.js
```

**目标**：用户无需 clone 仓库，一行命令即可安装并使用 Wingman。

**证据**：
- `package.json` 无 `"bin"` 字段，无 `"files"` 字段
- `wingman` 包名在 npm 已被占用（不相关包 `wingman@0.0.2`）
- `dist/` 在 `.gitignore` 中（符合规范），但发布时需要包含
- 选定 `@jafish/wingman-mcp` 作为发布包名

## 2. 必须保持的不变量

- MCP 工具 input/output schema 不变
- 环境变量名不变（`AUX_MODEL_*`）
- `build → test → smoke` 流水线不变
- 本地开发流程（`npm run dev`、`tsx`）不变
- 已注册的本地路径 MCP 配置不受影响

## 3. 范围

### 包含

- 选定 npm 包名
- 添加 `"bin"` 入口、`"files"` 发布白名单
- 添加 `prepublishOnly` 构建脚本
- 更新 README 安装说明（增加 npx 方式，保留本地 build 方式）
- 在 `docs/PLAN_MAP.md` 登记此计划

### 不包含

- MCP schema 变更
- 功能变更
- CI/CD 自动发布（手动 `npm publish` 即可）
- 变更开源 license

## 4. 目标 symbols 与影响分析

| Symbol | 文件 | 预期修改 | GitNexus risk |
|---|---|---|---|
| `package.json` | `package.json` | 添加 `bin`、`files`、`prepublishOnly`、确定 `name` | — |
| README 安装章节 | `README.md` | 增加 npx 安装方式 | — |
| PLAN_MAP | `docs/PLAN_MAP.md` | 添加此计划条目 | — |

无源码变更，不影响任何 MCP 行为。

## 5. Step 0：先建立红灯测试

### Fixture

- 输入：`npm pack --dry-run`
- Expectation：tarball 应包含 `dist/index.js`（入口文件）、`dist/` 下所有编译产物、`package.json`、`README.md`；不包含 `src/`、`test/`、`.env`、`node_modules/`
- 失败原因：当前 `dist/` 在 `.gitignore` 中，且无 `"files"` 字段，`npm pack` 会忽略 `dist/`

### 红灯确认

```text
运行命令：npm pack --dry-run 2>&1
预期失败断言：输出中不包含 dist/index.js
实际失败结果：已在实施阶段确认；最终完成证据见本计划“完成记录”。
```

## 6. 目标数据流

```text
开发者 npm publish
  → prepublishOnly: npm test && npm run build
  → npm pack 按 "files" 白名单打包
  → 发布到 npm registry

用户 npx @jafish/wingman-mcp
  → npm 自动下载 tarball
  → 执行 dist/index.js
  → Wingman MCP server 启动
```

## 7. 实施步骤

### Step 1：确定包名并修改 package.json

```jsonc
// package.json 变更
{
  "name": "@jafish/wingman-mcp",           // 原 "wingman"（已被占用）
  "version": "0.1.0",              // 不变
  "bin": {
    "wingman": "dist/index.js"     // 新增：npx / npm install -g 入口
  },
  "files": [                       // 新增：发布白名单
    "dist/",
    "README.md"
  ],
  "scripts": {
    "prepublishOnly": "npm test && npm run build",  // 新增：发布前自动检查
    // ... 原有 scripts 不变
  }
}
```

### Step 2：验证 npm pack 输出

```bash
npm pack --dry-run
# 确认包含：dist/index.js, dist/..., README.md, LICENSE, package.json
# 确认不包含：src/, test/, .env, node_modules, .claude/
```

### Step 3：更新 README 安装章节

在现有本地 build 方式之上，增加推荐方式：

```markdown
## 安装

### 推荐：npx（无需 clone）

```bash
claude mcp add -s user wingman -- npx -y @jafish/wingman-mcp
```

首次调用时自动下载并缓存，后续使用缓存版本。

### 本地 build

```bash
cd /path/to/wingman
npm install
npm run build
claude mcp add -s project wingman -- node /path/to/wingman/dist/index.js
```
```

### Step 4：发布

```bash
npm login
npm publish
```

### Step 5：验证端到端

```bash
# 清除缓存后测试
npx -y @jafish/wingman-mcp </dev/null   # 确认 bin 入口可启动并正常退出
claude mcp list              # 确认 MCP 注册可见
```

## 8. Schema Migration

无。MCP input/output schema 不变。

## 9. 回滚策略

- 回滚方式：在 npm 允许的时限和策略内执行 `npm unpublish @jafish/wingman-mcp@<version>`；一般优先发布修复版本
- 本地 build 方式不受影响，README 保留原有说明
- 已注册 `npx @jafish/wingman-mcp` 的用户需改回本地路径，可通过 README 说明

## 验证

```text
npm pack --dry-run          # 确认打包内容
npm test                    # 确认测试通过
npm run build               # 确认构建通过
npm run smoke               # 确认 smoke 通过
node dist/index.js </dev/null   # 确认 bin 入口可启动并正常退出
```

## 11. 完成定义

- [x] `npm pack --dry-run` 输出包含 `dist/index.js`，不含 `src/`、`test/`
- [x] `npm test && npm run build && npm run smoke` 全部通过
- [x] `node dist/index.js` 可启动（日志输出到 stderr）
- [x] README 增加 npx 安装方式，保留本地 build 方式
- [x] `docs/PLAN_MAP.md` 已更新
- [x] npm 发布成功，`npx -y @jafish/wingman-mcp` 可运行

## 12. 完成记录

- 完成日期：2026-06-28
- 发布结果：`@jafish/wingman-mcp@0.3.0` 已发布
- 计划地图：`docs/PLAN_MAP.md` 已标记为已完成

## 完成证据

- Step 0 证据：`npm pack --dry-run` 打包内容检查已转绿。
- 验证证据：`npm pack --dry-run`、`npm test`、`npm run build`、`npm run smoke` 和 `node dist/index.js </dev/null` 已通过。
- 发布证据：`@jafish/wingman-mcp@0.3.0` 已发布。

## 测试覆盖率

- 发布前验证覆盖打包内容、测试、构建、smoke 和 bin 入口启动。
- 测试通过：完成定义已确认 `npm test && npm run build && npm run smoke` 全部通过。
