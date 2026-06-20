/**
 * Command output chunking — identify output type and split into
 * meaningful error/section blocks.
 */

import type { InputChunk, ChunkMeta, OmittedChunk } from "./types.js";
import { parseTscDiagnostics } from "../diagnostics/tsc-parser.js";
import type { CommandDiagnostic } from "../diagnostics/types.js";
import { logger } from "../logger.js";

export type OutputKind =
  | "test_output"
  | "tsc_error"
  | "eslint_output"
  | "build_output"
  | "stack_trace"
  | "generic_log";

export interface CommandOutputMeta {
  kind: OutputKind;
  command?: string;
  exit_code?: number;
}

/**
 * Detect the output type based on content patterns.
 */
export function detectOutputKind(output: string): OutputKind {
  if (/error TS\d+:/m.test(output)) return "tsc_error";
  if (/^\s+\d+:\d+\s+error\s+/m.test(output) || /✖\s+\d+ problems?/m.test(output)) return "eslint_output";
  if (/^\s*(FAIL|✗|✘|×)\s+/m.test(output) || /^\s*FAILED\s/m.test(output) || /Tests?:.*failed/m.test(output)) return "test_output";
  if (/^\s*(ERROR|Error) in/m.test(output) || /BUILD FAILED|Compilation failed|make\[.*\]:.*Error/m.test(output)) return "build_output";
  if (/\n\s+at\s+.+\(.+:\d+:\d+\)/.test(output)) return "stack_trace";
  return "generic_log";
}

/**
 * Split command output into error/section blocks.
 */
export function chunkCommandOutput(
  output: string,
  maxChars: number = 120_000,
): { chunks: InputChunk[]; meta: ChunkMeta; outputMeta: CommandOutputMeta } {
  const kind = detectOutputKind(output);
  const omitted: OmittedChunk[] = [];
  const chunks: InputChunk[] = [];
  let chunkId = 0;

  logger.debug("chunkCommandOutput called", { outputLen: output.length, maxChars, kind });

  const truncated = output.length > maxChars;
  const workingOutput = truncated ? output.slice(0, maxChars) : output;

  switch (kind) {
    case "tsc_error": chunkTscErrors(workingOutput); break;
    case "eslint_output": chunkEslintOutput(workingOutput); break;
    case "test_output": chunkTestOutput(workingOutput); break;
    case "stack_trace": chunkStackTrace(workingOutput); break;
    default: chunkGenericOutput(workingOutput); break;
  }

  if (truncated) {
    omitted.push({
      id: "omitted-truncation",
      label: "truncated tail",
      reason: `Output truncated from ${output.length} to ${maxChars} chars`,
    });
  }

  function chunkTscErrors(text: string): void {
    const parsed = parseTscDiagnostics(text);
    const { diagnostics } = parsed;

    if (diagnostics.length === 0) {
      // No structured diagnostics found — fall back to full text chunk
      if (text.trim()) {
        chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: "tsc output", text, truncated: false });
      }
      return;
    }

    // Group diagnostics into batches by character budget (for model consumption)
    // Each batch is a JSON-serialized array of diagnostic summary objects
    const MAX_BATCH_CHARS = 6000;
    const MAX_PER_BATCH = 8;
    let batch: CommandDiagnostic[] = [];
    let batchChars = 0;

    const flushBatch = () => {
      if (batch.length === 0) return;
      const json = JSON.stringify(batch.map(d => ({
        id: d.id,
        kind: d.kind,
        file: d.file,
        line: d.line,
        column: d.column,
        error_code: d.error_code,
        headline: d.headline,
        details: d.details.slice(0, 5),  // limit detail lines per diagnostic in batch
        evidence: d.evidence,
        source_kind: d.source_kind,
        actionability: d.actionability,
        parser_confidence: d.parser_confidence,
      })));
      chunks.push({
        id: `chunk-${chunkId++}`,
        kind: "command-section",
        label: `tsc diagnostics batch #${chunkId}`,
        text: json,
        truncated: batchChars > MAX_BATCH_CHARS,
      });
      batch = [];
      batchChars = 0;
    };

    for (const d of diagnostics) {
      const dJson = JSON.stringify({
        id: d.id,
        kind: d.kind,
        file: d.file,
        line: d.line,
        column: d.column,
        error_code: d.error_code,
        headline: d.headline,
        evidence: d.evidence,
        source_kind: d.source_kind,
      });
      const dChars = dJson.length;

      if (batch.length >= MAX_PER_BATCH || (batchChars + dChars > MAX_BATCH_CHARS && batch.length > 0)) {
        flushBatch();
      }
      batch.push(d);
      batchChars += dChars;
    }
    flushBatch();

    // Add unrecognized segments as context chunks
    for (const seg of parsed.unrecognized_segments) {
      if (seg.trim()) {
        chunks.push({
          id: `chunk-${chunkId++}`,
          kind: "command-section",
          label: "unrecognized context",
          text: seg,
          truncated: false,
        });
      }
    }
  }

  function chunkEslintOutput(text: string): void {
    const fileRe = /^(\S+\.\w+)\s*$/gm;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = fileRe.exec(text)) !== null) {
      if (match.index > lastIdx) {
        const gap = text.slice(lastIdx, match.index).trim();
        if (gap) chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: "eslint header", text: gap, truncated: false });
      }
      fileRe.lastIndex = match.index + match[0].length;
      const nextMatch = fileRe.exec(text);
      if (!nextMatch) {
        fileRe.lastIndex = text.length;
      }
      const blockEnd = nextMatch ? nextMatch.index : text.length;
      const block = text.slice(match.index, blockEnd).trim();
      if (block) chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: match[1], text: block, source: match[1], truncated: false });
      lastIdx = blockEnd;
      if (nextMatch) fileRe.lastIndex = nextMatch.index;
    }
    if (chunks.length === 0 && text.trim()) {
      chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: "eslint output", text: text, truncated: false });
    }
  }

  function chunkTestOutput(text: string): void {
    const failRe = /^(FAIL|✗|✘|×)\s+.+$/gm;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = failRe.exec(text)) !== null) {
      if (match.index > lastIdx) {
        const gap = text.slice(lastIdx, match.index).trim();
        if (gap) chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: "test context", text: gap, truncated: false });
      }
      failRe.lastIndex = match.index + match[0].length;
      const nextMatch = failRe.exec(text);
      if (!nextMatch) {
        failRe.lastIndex = text.length;
      }
      const blockEnd = nextMatch ? nextMatch.index : text.length;
      const block = text.slice(match.index, blockEnd).trim();
      if (block) chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: `test failure #${chunkId}`, text: block, truncated: false });
      lastIdx = blockEnd;
      if (nextMatch) failRe.lastIndex = nextMatch.index;
    }
    if (lastIdx < text.length) {
      const tail = text.slice(lastIdx).trim();
      if (tail) chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: "test summary", text: tail, truncated: false });
    }
    if (chunks.length === 0 && text.trim()) {
      chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: "test output", text: text, truncated: false });
    }
  }

  function chunkStackTrace(text: string): void {
    const errorRe = /^(\w+(?:Error|Exception|Panic|Fault|Abort)[:\s].*)$/gm;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = errorRe.exec(text)) !== null) {
      if (match.index > lastIdx) {
        const gap = text.slice(lastIdx, match.index).trim();
        if (gap) chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: "context", text: gap, truncated: false });
      }
      errorRe.lastIndex = match.index + match[0].length;
      const nextMatch = errorRe.exec(text);
      if (!nextMatch) {
        errorRe.lastIndex = text.length;
      }
      const blockEnd = nextMatch ? nextMatch.index : text.length;
      const block = text.slice(match.index, blockEnd).trim();
      if (block) chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: `stack trace #${chunkId}`, text: block, truncated: false });
      lastIdx = blockEnd;
      if (nextMatch) errorRe.lastIndex = nextMatch.index;
    }
    if (lastIdx < text.length) {
      const tail = text.slice(lastIdx).trim();
      if (tail) chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: "tail", text: tail, truncated: false });
    }
    if (chunks.length === 0 && text.trim()) {
      chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: "full output", text: text, truncated: false });
    }
  }

  function chunkGenericOutput(text: string): void {
    const lines = text.split(/\r?\n/);
    const signalRe = /\b(ERROR|WARN|FATAL|Exception|Timeout|failed|PANIC|CRITICAL)\b/i;
    const blocks: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      if (signalRe.test(lines[i])) {
        const ctxStart = Math.max(0, i - 2);
        const ctxEnd = Math.min(lines.length, i + 4);
        if (blocks.length > 0 && blocks[blocks.length - 1].end >= ctxStart) {
          blocks[blocks.length - 1].end = ctxEnd;
        } else {
          blocks.push({ start: ctxStart, end: ctxEnd });
        }
      }
    }
    if (blocks.length === 0) {
      chunks.push({ id: `chunk-${chunkId++}`, kind: "command-section", label: "full output", text: text, truncated: false });
      return;
    }
    let covered = 0;
    for (const block of blocks) {
      if (block.start > covered) {
        omitted.push({
          id: `omitted-${chunkId}`,
          label: `lines ${covered + 1}-${block.start}`,
          reason: "No signal keywords in this section",
          start_line: covered + 1,
          end_line: block.start,
        });
      }
      chunks.push({
        id: `chunk-${chunkId++}`,
        kind: "command-section",
        label: `lines ${block.start + 1}-${block.end}`,
        text: lines.slice(block.start, block.end).join("\n"),
        start_line: block.start + 1,
        end_line: block.end,
        truncated: false,
      });
      covered = block.end;
    }
  }

  const totalChunks = chunks.length + omitted.length;

  logger.debug("chunkCommandOutput result", {
    kind,
    chunks: chunks.length,
    totalChunks,
    omitted: omitted.length,
    truncated,
  });

  return {
    chunks,
    meta: {
      total_chunks: totalChunks,
      analyzed_chunks: chunks.length,
      omitted_chunks: omitted.length,
      omitted,
      input_truncated: truncated,
      chunking_strategy: `command-output-${kind}`,
    },
    outputMeta: { kind },
  };
}
