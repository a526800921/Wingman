import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkDiff, splitDiffByFile, isBinaryFile } from "../src/chunking/diff.js";

describe("splitDiffByFile", () => {
  it("splits multi-file diff into per-file sections", () => {
    const diff = [
      "--- a/file1.ts\n+++ b/file1.ts",
      "@@ -1,3 +1,4 @@",
      "+added line",
      " context",
      "--- a/file2.ts\n+++ b/file2.ts",
      "@@ -10,2 +10,3 @@",
      "+another addition",
    ].join("\n");
    const sections = splitDiffByFile(diff);
    assert.ok(sections.length >= 2, `Expected >=2 sections, got ${sections.length}`);
    assert.ok(sections.some(s => s.newPath.includes("file1.ts")));
    assert.ok(sections.some(s => s.newPath.includes("file2.ts")));
  });
});

describe("isBinaryFile", () => {
  it("identifies binary files by extension", () => {
    assert.ok(isBinaryFile("image.png"));
    assert.ok(isBinaryFile("font.woff2"));
    assert.ok(isBinaryFile("archive.zip"));
    assert.ok(!isBinaryFile("src/app.ts"));
    assert.ok(!isBinaryFile("README.md"));
  });
});

describe("chunkDiff", () => {
  it("returns empty result for empty diff", () => {
    const { chunks, meta } = chunkDiff("");
    assert.equal(chunks.length, 0);
    assert.equal(meta.total_chunks, 0);
    assert.equal(meta.analyzed_chunks, 0);
  });

  it("chunks a simple multi-file diff", () => {
    const diff = [
      "--- a/src/a.ts\n+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      "+new line",
      "--- a/src/b.ts\n+++ b/src/b.ts",
      "@@ -1,1 +1,1 @@",
      "-old line",
    ].join("\n");
    const { chunks, meta } = chunkDiff(diff);
    assert.ok(chunks.length >= 2);
    assert.equal(meta.chunking_strategy, "diff-by-file-then-hunk");
    assert.equal(meta.omitted_chunks, 0);
  });

  it("omits binary files", () => {
    const diff = [
      "--- a/icon.png\n+++ b/icon.png",
      "@@ -1,1 +1,1 @@",
      " binary",
    ].join("\n");
    const { chunks, meta } = chunkDiff(diff);
    const omitted = meta.omitted.filter(o => o.reason.includes("Binary"));
    assert.ok(omitted.length > 0);
  });

  it("respects max_files limit", () => {
    let diff = "";
    for (let i = 0; i < 15; i++) {
      diff += `--- a/file${i}.ts\n+++ b/file${i}.ts\n@@ -1,1 +1,1 @@\n+line\n`;
    }
    const { meta } = chunkDiff(diff, { max_files: 10 });
    const fileLimitOmissions = meta.omitted.filter(o => o.reason.includes("max_files"));
    assert.ok(fileLimitOmissions.length > 0, "Files beyond max_files should be omitted");
  });
});
