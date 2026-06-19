/**
 * Workspace path resolution unit tests.
 *
 * 运行: node --import tsx --test test/workspace.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveSafePath, isDosDeviceName } from "../src/workspace.js";
import { tmpdir, platform } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, sep } from "node:path";

const isWindows = platform() === "win32";

describe("isDosDeviceName", () => {
  it("detects CON", () => assert.equal(isDosDeviceName("CON"), true));
  it("detects PRN", () => assert.equal(isDosDeviceName("PRN"), true));
  it("detects NUL", () => assert.equal(isDosDeviceName("NUL"), true));
  it("detects AUX", () => assert.equal(isDosDeviceName("AUX"), true));
  it("detects COM1", () => assert.equal(isDosDeviceName("COM1"), true));
  it("detects COM9", () => assert.equal(isDosDeviceName("COM9"), true));
  it("detects LPT1", () => assert.equal(isDosDeviceName("LPT1"), true));
  it("detects LPT9", () => assert.equal(isDosDeviceName("LPT9"), true));
  it("detects CON.txt (extension stripped)", () =>
    assert.equal(isDosDeviceName("CON.txt"), true));
  it("detects NUL.dat", () => assert.equal(isDosDeviceName("NUL.dat"), true));
  it("case insensitive", () => assert.equal(isDosDeviceName("con"), true));
  it("case insensitive nul", () => assert.equal(isDosDeviceName("nul"), true));
  it("passes normal filename", () => assert.equal(isDosDeviceName("hello.ts"), false));
  it("passes package.json", () =>
    assert.equal(isDosDeviceName("package.json"), false));
});

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

  it("accepts simple relative path", () => {
    const result = resolveSafePath(wsRoot(), "src/index.ts");
    assert.ok(result.startsWith(wsRoot()), `${result} should start with ${wsRoot()}`);
  });

  it("accepts nested relative path", () => {
    const result = resolveSafePath(wsRoot(), join("a", "b", "c.ts"));
    assert.ok(result.startsWith(wsRoot()));
  });

  it("accepts path with dot", () => {
    const result = resolveSafePath(wsRoot(), join(".", "src", "index.ts"));
    assert.ok(result.startsWith(wsRoot()));
  });

  it("rejects absolute Unix path", () => {
    assert.throws(
      () => resolveSafePath(wsRoot(), "/etc/passwd"),
      { message: /absolute/i },
    );
  });

  it("rejects absolute Windows path", () => {
    assert.throws(
      () => resolveSafePath(wsRoot(), "C:\\Windows\\System32"),
      { message: /absolute/i },
    );
  });

  it("rejects UNC path", () => {
    assert.throws(
      () => resolveSafePath(wsRoot(), "\\\\server\\share\\file"),
      { message: /UNC|unc|network/i },
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

describe("resolveSafePath — DOS device names", () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "aux-mcp-dos-"));
    mkdirSync(join(tmpRoot, "ws"), { recursive: true });
  });

  after(() => {
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  const wsRoot = () => join(tmpRoot, "ws");
  const dosNames = ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"];

  for (const name of dosNames) {
    it(`rejects ${name}`, () => {
      assert.throws(() => resolveSafePath(wsRoot(), name), {
        message: /reserved|device/i,
      });
    });

    it(`rejects ${name}.ts`, () => {
      assert.throws(() => resolveSafePath(wsRoot(), `${name}.ts`), {
        message: /reserved|device/i,
      });
    });

    it(`rejects subdir/${name}`, () => {
      assert.throws(
        () => resolveSafePath(wsRoot(), join("subdir", name)),
        { message: /reserved|device/i },
      );
    });
  }
});

describe("resolveSafePath — NTFS ADS (Windows only)", () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "aux-mcp-ads-"));
    mkdirSync(join(tmpRoot, "ws"), { recursive: true });
  });

  after(() => {
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  const wsRoot = () => join(tmpRoot, "ws");

  if (!isWindows) {
    it("NTFS ADS tests skipped on non-Windows", () => {});
    return;
  }

  it("rejects alternate data stream syntax", () => {
    assert.throws(
      () => resolveSafePath(wsRoot(), "file.txt::$DATA"),
      { message: /stream|colon/i },
    );
  });

  it("rejects named stream", () => {
    assert.throws(
      () => resolveSafePath(wsRoot(), "file.txt:secret"),
      { message: /stream|colon/i },
    );
  });
});
