/**
 * aux_tool_stats 测试 — 覆盖调用计数、token 累计、并发归属、持久化、
 * 损坏恢复和路径迁移。
 *
 * 运行: node --import tsx --test test/tool-usage-stats.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const TMP_DIR = join(__dirname, "..", "tmp_tool_stats_test");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupTmpDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

function cleanupTmpDir() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 统计模块单元测试（无需 MCP server）
// ---------------------------------------------------------------------------

describe("tool-stats module", () => {
  let toolStats: typeof import("../src/tool-stats.js");

  before(async () => {
    toolStats = await import("../src/tool-stats.js");
  });

  beforeEach(() => {
    const tmpFile = join(TMP_DIR, "test-stats.json");
    toolStats.resetToolStats(tmpFile);
    try { unlinkSync(tmpFile); } catch { /* ok */ }
  });

  before(setupTmpDir);
  after(cleanupTmpDir);

  it("初始快照 tools 为空数组", () => {
    const snapshot = toolStats.getToolStatsSnapshot();
    assert.equal(snapshot.tools.length, 0);
    assert.equal(snapshot.storage_scope, "local_file");
    assert.ok(snapshot.generated_at.length > 0);
    assert.ok(snapshot.stats_file.length > 0);
  });

  it("recordToolCall 增加 calls 计数", () => {
    toolStats.recordToolCall("aux_compress_text");
    toolStats.recordToolCall("aux_compress_text");
    toolStats.recordToolCall("aux_summarize_file");

    const snapshot = toolStats.getToolStatsSnapshot();
    assert.equal(snapshot.tools.length, 2);

    const ct = snapshot.tools.find(t => t.tool_name === "aux_compress_text");
    assert.ok(ct);
    assert.equal(ct.calls, 2);
    assert.equal(ct.input_tokens, 0);
    assert.equal(ct.output_tokens, 0);
    assert.equal(ct.total_tokens, 0);

    const sf = snapshot.tools.find(t => t.tool_name === "aux_summarize_file");
    assert.ok(sf);
    assert.equal(sf.calls, 1);
  });

  it("recordToolUsage 在当前 tool 上下文中累计 token", () => {
    toolStats.runInToolContext("aux_review_diff", () => {
      toolStats.recordToolCall("aux_review_diff");
      toolStats.recordToolUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
      toolStats.recordToolUsage({ prompt_tokens: 30, completion_tokens: 20 });
    });

    const snapshot = toolStats.getToolStatsSnapshot();
    const rd = snapshot.tools.find(t => t.tool_name === "aux_review_diff");
    assert.ok(rd);
    assert.equal(rd.calls, 1);
    assert.equal(rd.input_tokens, 130);
    assert.equal(rd.output_tokens, 70);
    // total_tokens: 150 + (30+20) = 200
    assert.equal(rd.total_tokens, 200);
  });

  it("无当前 tool 时 recordToolUsage 静默忽略", () => {
    // 不在 runInToolContext 内调用——无上下文
    toolStats.recordToolUsage({ prompt_tokens: 999, completion_tokens: 999, total_tokens: 1998 });

    const snapshot = toolStats.getToolStatsSnapshot();
    assert.equal(snapshot.tools.length, 0);
  });

  it("离开 runInToolContext 后 token 不再归属到前一个 tool", () => {
    toolStats.runInToolContext("aux_compress_text", () => {
      toolStats.recordToolCall("aux_compress_text");
      toolStats.recordToolUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    });

    // 在上下文外调用——不应归属
    toolStats.recordToolUsage({ prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 });

    const snapshot = toolStats.getToolStatsSnapshot();
    const ct = snapshot.tools.find(t => t.tool_name === "aux_compress_text");
    assert.ok(ct);
    assert.equal(ct.total_tokens, 15); // 只有上下文内的第一笔
  });

  it("同一 tool 多次模型调用 token 累计正确", () => {
    toolStats.runInToolContext("aux_compress_command_output", () => {
      toolStats.recordToolCall("aux_compress_command_output");

      // 模拟多次模型调用（如 batch）
      for (let i = 0; i < 5; i++) {
        toolStats.recordToolUsage({
          prompt_tokens: 50,
          completion_tokens: 30,
          total_tokens: 80,
        });
      }
    });

    const snapshot = toolStats.getToolStatsSnapshot();
    const cco = snapshot.tools.find(t => t.tool_name === "aux_compress_command_output");
    assert.ok(cco);
    assert.equal(cco.calls, 1);
    assert.equal(cco.input_tokens, 250);
    assert.equal(cco.output_tokens, 150);
    assert.equal(cco.total_tokens, 400);
  });

  it("usage 无 total_tokens 时使用 prompt+completion 计算", () => {
    toolStats.runInToolContext("aux_summarize_file", () => {
      toolStats.recordToolCall("aux_summarize_file");
      toolStats.recordToolUsage({ prompt_tokens: 11, completion_tokens: 7 });
    });

    const snapshot = toolStats.getToolStatsSnapshot();
    const sf = snapshot.tools.find(t => t.tool_name === "aux_summarize_file");
    assert.ok(sf);
    assert.equal(sf.input_tokens, 11);
    assert.equal(sf.output_tokens, 7);
    assert.equal(sf.total_tokens, 18);
  });

  it("usage 完全为空时 token 不增长", () => {
    toolStats.runInToolContext("aux_review_diff_by_file", () => {
      toolStats.recordToolCall("aux_review_diff_by_file");
      toolStats.recordToolUsage({});
    });

    const snapshot = toolStats.getToolStatsSnapshot();
    const rdb = snapshot.tools.find(t => t.tool_name === "aux_review_diff_by_file");
    assert.ok(rdb);
    assert.equal(rdb.calls, 1);
    assert.equal(rdb.input_tokens, 0);
    assert.equal(rdb.output_tokens, 0);
    assert.equal(rdb.total_tokens, 0);
  });
});

// ---------------------------------------------------------------------------
// 并发归属测试
// ---------------------------------------------------------------------------

describe("tool-stats concurrency", () => {
  let toolStats: typeof import("../src/tool-stats.js");

  before(async () => {
    toolStats = await import("../src/tool-stats.js");
  });

  beforeEach(() => {
    const tmpFile = join(TMP_DIR, "concurrent-stats.json");
    toolStats.resetToolStats(tmpFile);
    try { unlinkSync(tmpFile); } catch { /* ok */ }
  });

  before(setupTmpDir);
  after(cleanupTmpDir);

  it("并发 tool 调用不会串号 token 归属", async () => {
    // 模拟两个并发请求：A 和 B
    const results: string[] = [];

    await Promise.all([
      // 请求 A：慢速模型调用
      new Promise<void>(resolve => {
        toolStats.runInToolContext("aux_review_diff", () => {
          toolStats.recordToolCall("aux_review_diff");
          // 模拟 "慢" 模型调用
          setImmediate(() => {
            toolStats.recordToolUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
            results.push("A-done");
            resolve();
          });
        });
      }),
      // 请求 B：快速模型调用，在 A 的 setImmediate 回调之前完成
      new Promise<void>(resolve => {
        toolStats.runInToolContext("aux_compress_text", () => {
          toolStats.recordToolCall("aux_compress_text");
          toolStats.recordToolUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
          results.push("B-done");
          resolve();
        });
      }),
    ]);

    // 等待两个都完成
    await new Promise(r => setImmediate(r));

    const snapshot = toolStats.getToolStatsSnapshot();

    const rd = snapshot.tools.find(t => t.tool_name === "aux_review_diff");
    assert.ok(rd, "should have aux_review_diff");
    assert.equal(rd.calls, 1);
    assert.equal(rd.input_tokens, 100);
    assert.equal(rd.output_tokens, 50);
    assert.equal(rd.total_tokens, 150);

    const ct = snapshot.tools.find(t => t.tool_name === "aux_compress_text");
    assert.ok(ct, "should have aux_compress_text");
    assert.equal(ct.calls, 1);
    assert.equal(ct.input_tokens, 10);
    assert.equal(ct.output_tokens, 5);
    assert.equal(ct.total_tokens, 15);

    // 两个都完成了
    assert.equal(results.length, 2);
  });

  it("嵌套 runInToolContext 内层覆盖外层的 tool 归属", () => {
    toolStats.runInToolContext("outer_tool", () => {
      toolStats.recordToolCall("outer_tool");
      toolStats.recordToolUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });

      // 嵌套上下文——内层覆盖
      toolStats.runInToolContext("inner_tool", () => {
        toolStats.recordToolCall("inner_tool");
        toolStats.recordToolUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      });

      // 回到外层
      toolStats.recordToolUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    });

    const snapshot = toolStats.getToolStatsSnapshot();

    const outer = snapshot.tools.find(t => t.tool_name === "outer_tool");
    assert.ok(outer);
    assert.equal(outer.calls, 1);
    assert.equal(outer.total_tokens, 4); // 2 + 2

    const inner = snapshot.tools.find(t => t.tool_name === "inner_tool");
    assert.ok(inner);
    assert.equal(inner.calls, 1);
    assert.equal(inner.total_tokens, 15);
  });
});

// ---------------------------------------------------------------------------
// 持久化测试
// ---------------------------------------------------------------------------

describe("tool-stats persistence", () => {
  let toolStats: typeof import("../src/tool-stats.js");
  const statsFile = join(TMP_DIR, "persist-stats.json");

  before(async () => {
    toolStats = await import("../src/tool-stats.js");
  });

  beforeEach(() => {
    toolStats.resetToolStats(statsFile);
    try { unlinkSync(statsFile); } catch { /* ok */ }
  });

  before(setupTmpDir);
  after(cleanupTmpDir);

  it("flushToolStats 写入文件后可被新实例读回", () => {
    toolStats.runInToolContext("aux_compress_text", () => {
      toolStats.recordToolCall("aux_compress_text");
      toolStats.recordToolUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    });

    toolStats.flushToolStats();
    assert.ok(existsSync(statsFile), "persisted stats file should exist");

    // 重置并重新加载
    toolStats.resetToolStats(statsFile);
    const snapshot = toolStats.getToolStatsSnapshot();

    const ct = snapshot.tools.find(t => t.tool_name === "aux_compress_text");
    assert.ok(ct, "should have aux_compress_text after reload");
    assert.equal(ct.calls, 1);
    assert.equal(ct.input_tokens, 100);
    assert.equal(ct.output_tokens, 50);
    assert.equal(ct.total_tokens, 150);
  });

  it("stats 在多次 flush 之间保持累计", () => {
    toolStats.runInToolContext("aux_summarize_file", () => {
      toolStats.recordToolCall("aux_summarize_file");
      toolStats.recordToolCall("aux_summarize_file");
      toolStats.recordToolUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    });
    toolStats.flushToolStats();

    // 第二次调用（同一进程实例，文件已存在）
    toolStats.runInToolContext("aux_summarize_file", () => {
      toolStats.recordToolCall("aux_summarize_file");
      toolStats.recordToolUsage({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
    });
    toolStats.flushToolStats();

    // 重新加载
    toolStats.resetToolStats(statsFile);
    const snapshot = toolStats.getToolStatsSnapshot();

    const sf = snapshot.tools.find(t => t.tool_name === "aux_summarize_file");
    assert.ok(sf);
    assert.equal(sf.calls, 3);
    assert.equal(sf.input_tokens, 15);
    assert.equal(sf.output_tokens, 8);
    assert.equal(sf.total_tokens, 23);
  });

  it("多个 tool 统计分别持久化和恢复", () => {
    const tools = ["aux_compress_text", "aux_review_diff", "aux_summarize_file"];
    for (const name of tools) {
      toolStats.runInToolContext(name, () => {
        toolStats.recordToolCall(name);
        toolStats.recordToolUsage({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
      });
    }
    toolStats.flushToolStats();

    toolStats.resetToolStats(statsFile);
    const snapshot = toolStats.getToolStatsSnapshot();

    assert.equal(snapshot.tools.length, 3);
    for (const name of tools) {
      const entry = snapshot.tools.find(t => t.tool_name === name);
      assert.ok(entry, `should have ${name}`);
      assert.equal(entry.calls, 1);
      assert.equal(entry.total_tokens, 30);
    }
  });

  it("损坏的 JSON 文件从空统计恢复", () => {
    writeFileSync(statsFile, "this is not valid json{{{", "utf-8");
    toolStats.resetToolStats(statsFile);
    const snapshot = toolStats.getToolStatsSnapshot();
    assert.equal(snapshot.tools.length, 0);
  });

  it("schema_version 不匹配时从空统计恢复", () => {
    writeFileSync(statsFile, JSON.stringify({
      schema_version: 999,
      updated_at: new Date().toISOString(),
      tools: { "aux_compress_text": { calls: 5, input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
    }), "utf-8");

    toolStats.resetToolStats(statsFile);
    const snapshot = toolStats.getToolStatsSnapshot();
    assert.equal(snapshot.tools.length, 0);
  });

  it("tools 字段为非对象时从空统计恢复", () => {
    writeFileSync(statsFile, JSON.stringify({
      schema_version: 1,
      updated_at: new Date().toISOString(),
      tools: "not an object",
    }), "utf-8");

    toolStats.resetToolStats(statsFile);
    const snapshot = toolStats.getToolStatsSnapshot();
    assert.equal(snapshot.tools.length, 0);
  });

  it("AUX_TOOL_STATS_FILE 环境变量改变持久化路径", () => {
    const customFile = join(TMP_DIR, "custom-stats.json");
    try { unlinkSync(customFile); } catch { /* ok */ }

    const saved = process.env.AUX_TOOL_STATS_FILE;
    process.env.AUX_TOOL_STATS_FILE = customFile;

    try {
      toolStats.resetToolStats(customFile);

      toolStats.runInToolContext("aux_compress_text", () => {
        toolStats.recordToolCall("aux_compress_text");
        toolStats.recordToolUsage({ prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 });
      });
      toolStats.flushToolStats();

      assert.ok(existsSync(customFile), "custom stats file should exist");
      assert.equal(
        existsSync(join(homedir(), ".wingman", "tool-stats.json")),
        false,
        "default stats file should not be created when custom path is set",
      );
    } finally {
      if (saved) {
        process.env.AUX_TOOL_STATS_FILE = saved;
      } else {
        delete process.env.AUX_TOOL_STATS_FILE;
      }
      try { unlinkSync(customFile); } catch { /* ok */ }
    }
  });
});

// ---------------------------------------------------------------------------
// 默认路径迁移测试
// ---------------------------------------------------------------------------

describe("default path migration", () => {
  it("resolveLogFilePath 默认路径为 ~/.wingman/wingman.log", async () => {
    const saved = process.env.AUX_LOG_FILE;
    delete process.env.AUX_LOG_FILE;

    try {
      const logger = await import("../src/logger.js");
      logger.resetLogFileCache();
      const path = logger.getLogFilePath();
      assert.ok(path !== null, "should have a default log path");
      assert.ok(
        path.includes(".wingman") && path.includes("wingman.log"),
        `expected path to contain .wingman/wingman.log, got: ${path}`,
      );
    } finally {
      if (saved) process.env.AUX_LOG_FILE = saved;
    }
  });

  it("AUX_LOG_FILE 显式设置时覆盖默认路径", async () => {
    const saved = process.env.AUX_LOG_FILE;
    process.env.AUX_LOG_FILE = join(TMP_DIR, "custom.log");

    try {
      const logger = await import("../src/logger.js");
      logger.resetLogFileCache();
      const path = logger.getLogFilePath();
      assert.ok(path !== null);
      assert.ok(path.includes("custom.log"), `expected custom.log in path, got: ${path}`);
    } finally {
      if (saved) process.env.AUX_LOG_FILE = saved;
      else delete process.env.AUX_LOG_FILE;
    }
  });

  it("summarize-feedback 默认输出为 ~/.wingman/feedback-reports/", () => {
    const defaultDir = join(homedir(), ".wingman", "feedback-reports");
    assert.ok(defaultDir.includes(".wingman"));
    assert.ok(defaultDir.includes("feedback-reports"));
  });
});

// ---------------------------------------------------------------------------
// aux_tool_stats 自身统计
// ---------------------------------------------------------------------------

describe("aux_tool_stats self-tracking", () => {
  let toolStats: typeof import("../src/tool-stats.js");

  before(async () => {
    toolStats = await import("../src/tool-stats.js");
  });

  beforeEach(() => {
    const tmpFile = join(TMP_DIR, "self-track-stats.json");
    toolStats.resetToolStats(tmpFile);
    try { unlinkSync(tmpFile); } catch { /* ok */ }
  });

  before(setupTmpDir);
  after(cleanupTmpDir);

  it("aux_tool_stats 的 calls 会被记录", () => {
    toolStats.recordToolCall("aux_tool_stats");
    toolStats.recordToolCall("aux_tool_stats");

    const snapshot = toolStats.getToolStatsSnapshot();
    const self = snapshot.tools.find(t => t.tool_name === "aux_tool_stats");
    assert.ok(self);
    assert.equal(self.calls, 2);
  });

  it("aux_tool_stats 无模型调用所以 token 为 0", () => {
    toolStats.runInToolContext("aux_tool_stats", () => {
      toolStats.recordToolCall("aux_tool_stats");
    });

    const snapshot = toolStats.getToolStatsSnapshot();
    const self = snapshot.tools.find(t => t.tool_name === "aux_tool_stats");
    assert.ok(self);
    assert.equal(self.total_tokens, 0);
  });
});

// ---------------------------------------------------------------------------
// aux_tool_stats handler schema 合规测试
// ---------------------------------------------------------------------------

describe("aux_tool_stats output schema compliance", () => {
  let ToolStatsOutputSchema: { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } };

  before(async () => {
    const schema = await import("../src/schema.js");
    ToolStatsOutputSchema = schema.ToolStatsOutputSchema as typeof ToolStatsOutputSchema;
  });

  it("带 is_authoritative: false 的输出通过 schema 校验", () => {
    const snapshot = {
      tools: [{ tool_name: "test", calls: 1, input_tokens: 0, output_tokens: 0, total_tokens: 0 }],
      generated_at: new Date().toISOString(),
      storage_scope: "local_file",
      stats_file: "/tmp/test.json",
      is_authoritative: false,
    };
    const result = ToolStatsOutputSchema.safeParse(snapshot);
    assert.ok(result.success, `schema validation should pass: ${result.error?.message ?? JSON.stringify(result.error)}`);
  });

  it("缺少 is_authoritative 时 schema 拒绝", () => {
    const bad = {
      tools: [],
      generated_at: new Date().toISOString(),
      storage_scope: "local_file",
      stats_file: "/tmp/test.json",
    };
    const result = ToolStatsOutputSchema.safeParse(bad);
    assert.equal(result.success, false);
  });
});
