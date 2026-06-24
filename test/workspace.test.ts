/**
 * Workspace path resolution unit tests.
 *
 * 运行: node --import tsx --test test/workspace.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveSafePath } from "../src/workspace.js";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

describe("resolveSafePath", () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "aux-mcp-ws-"));
    mkdirSync(join(tmpRoot, "ws"), { recursive: true });
  });

  after(() => {
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  const wsRoot = () => join(tmpRoot, "ws");
  const realWsRoot = () => realpathSync(wsRoot());

  it("accepts simple relative path", () => {
    const result = resolveSafePath(wsRoot(), "src/index.ts");
    assert.ok(result.startsWith(realWsRoot()), `${result} should start with ${realWsRoot()}`);
  });

  it("accepts nested relative path", () => {
    const result = resolveSafePath(wsRoot(), join("a", "b", "c.ts"));
    assert.ok(result.startsWith(realWsRoot()));
  });

  it("accepts path with dot", () => {
    const result = resolveSafePath(wsRoot(), join(".", "src", "index.ts"));
    assert.ok(result.startsWith(realWsRoot()));
  });

  it("rejects absolute Unix path", () => {
    assert.throws(
      () => resolveSafePath(wsRoot(), "/etc/passwd"),
      { message: /absolute/i },
    );
  });

  it("rejects .. traversal", () => {
    assert.throws(
      () => resolveSafePath(wsRoot(), "../../../etc/passwd"),
    );
  });

  it("rejects complex .. traversal", () => {
    assert.throws(
      () => resolveSafePath(wsRoot(), join("a", "..", "..", "..", "b")),
    );
  });

  it("rejects empty path", () => {
    assert.throws(
      () => resolveSafePath(wsRoot(), ""),
      { message: /empty|invalid/i },
    );
  });
});
