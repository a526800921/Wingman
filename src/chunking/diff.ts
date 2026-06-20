/**
 * Diff chunking — split unified diff by file, then by hunk if needed.
 * Respects file analysis priority.
 */

import type { InputChunk, OmittedChunk, ChunkMeta } from "./types.js";
import { logger } from "../logger.js";

export interface DiffChunkOptions {
  max_chars_per_file?: number;  // default 40_000
  max_files?: number;           // default 30
}

interface FileSection {
  oldPath: string;
  newPath: string;
  header: string;    // "--- a/old\n+++ b/new"
  body: string;      // hunks
}

/**
 * Split a unified diff string into per-file sections.
 */
export function splitDiffByFile(diff: string): FileSection[] {
  const sections: FileSection[] = [];
  const fileHeaderRe = /^---\s+(\S+).*\n\+\+\+\s+(\S+).*/gm;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = fileHeaderRe.exec(diff)) !== null) {
    if (lastIdx < match.index) {
      sections.push({
        oldPath: "",
        newPath: "",
        header: diff.slice(lastIdx, match.index),
        body: "",
      });
    }
    const bodyStart = match.index + match[0].length;
    // Lookahead: find the next file header to determine where this file's body ends.
    // If exec returns null, lastIndex is reset to 0 for global regexes — restore it
    // to diff.length to prevent the outer while loop from re-matching infinitely.
    fileHeaderRe.lastIndex = bodyStart;
    const savedLastIndex = fileHeaderRe.lastIndex;
    const nextMatch = fileHeaderRe.exec(diff);
    if (!nextMatch) {
      fileHeaderRe.lastIndex = diff.length;
    }
    const bodyEnd = nextMatch ? nextMatch.index : diff.length;
    sections.push({
      oldPath: match[1],
      newPath: match[2],
      header: match[0],
      body: diff.slice(bodyStart, bodyEnd),
    });
    lastIdx = bodyEnd;
    if (nextMatch) {
      fileHeaderRe.lastIndex = nextMatch.index;
    }
  }

  return sections;
}

/**
 * File analysis priority (lower = higher priority).
 */
const PRIORITY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|requirements\.txt|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile|Gemfile\.lock|composer\.json|composer\.lock|poetry\.lock|pyproject\.toml|build\.gradle|build\.gradle\.kts)$/i, label: "manifest/lock" },
  { pattern: /\b(auth|permission|security|token|secret|crypto|oauth|session|certificate|credential|password|key)\b/i, label: "security" },
];

function getFilePriority(filePath: string): number {
  for (let i = 0; i < PRIORITY_PATTERNS.length; i++) {
    if (PRIORITY_PATTERNS[i].pattern.test(filePath)) return i;
  }
  if (/\.(ts|tsx|js|jsx|py|rs|go|java|rb)$/i.test(filePath) && !/\.(test|spec)\./.test(filePath)) return 100;
  if (/\.(test|spec)\./.test(filePath)) return 200;
  if (/\.(md|mdx|txt|yml|yaml|toml|json|xml)$/i.test(filePath)) return 300;
  return 400;
}

/**
 * Check if a file path suggests binary content.
 */
export function isBinaryFile(filePath: string): boolean {
  const BINARY_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".woff", ".woff2",
    ".ttf", ".eot", ".otf", ".mp4", ".mov", ".avi", ".webm", ".mp3",
    ".wav", ".ogg", ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
    ".exe", ".dll", ".so", ".dylib", ".wasm", ".class", ".jar", ".war",
  ]);
  const lower = filePath.toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Split a file section body into hunk-level chunks.
 */
export function splitBodyByHunk(body: string, _filePath: string): Array<{ hunkHeader: string; content: string }> {
  const hunkRe = /^@@\s+-(\d+),?(\d*)\s+\+(\d+),?(\d*)\s+@@.*\n/gm;
  const chunks: Array<{ hunkHeader: string; content: string }> = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = hunkRe.exec(body)) !== null) {
    if (lastIdx < match.index) {
      chunks.push({ hunkHeader: "", content: body.slice(lastIdx, match.index) });
    }
    const contentStart = match.index + match[0].length;
    // Same null-reset guard as splitDiffByFile
    hunkRe.lastIndex = contentStart;
    const nextMatch = hunkRe.exec(body);
    if (!nextMatch) {
      hunkRe.lastIndex = body.length;
    }
    const contentEnd = nextMatch ? nextMatch.index : body.length;
    chunks.push({ hunkHeader: match[0], content: body.slice(contentStart, contentEnd) });
    lastIdx = contentEnd;
    if (nextMatch) hunkRe.lastIndex = nextMatch.index;
  }

  return chunks;
}

/**
 * Main entry: chunk a unified diff into InputChunk[] with priority-based
 * file selection and omitted tracking.
 */
export function chunkDiff(
  diff: string,
  options: DiffChunkOptions = {},
): { chunks: InputChunk[]; meta: ChunkMeta } {
  const maxCharsPerFile = options.max_chars_per_file ?? 40_000;
  const maxFiles = options.max_files ?? 30;

  logger.debug("chunkDiff called", { diffLen: diff.length, maxCharsPerFile, maxFiles });

  const fileSections = splitDiffByFile(diff);
  const omitted: OmittedChunk[] = [];
  const chunks: InputChunk[] = [];
  let totalChunks = 0;
  let chunkId = 0;

  const prioritized = fileSections.map((section, i) => ({
    section,
    priority: getFilePriority(section.newPath || section.oldPath),
    originalIndex: i,
  }));
  prioritized.sort((a, b) => a.priority - b.priority || a.originalIndex - b.originalIndex);

  for (let i = 0; i < prioritized.length; i++) {
    const { section } = prioritized[i];
    const filePath = section.newPath || section.oldPath;

    if (i >= maxFiles) {
      omitted.push({
        id: `omitted-file-${i}`,
        label: filePath,
        source: filePath,
        reason: `Exceeded max_files limit (${maxFiles})`,
      });
      continue;
    }

    if (isBinaryFile(filePath)) {
      omitted.push({
        id: `omitted-binary-${i}`,
        label: filePath,
        source: filePath,
        reason: "Binary file — content not analyzed",
      });
      continue;
    }

    const fullText = section.header + section.body;

    if (fullText.length <= maxCharsPerFile) {
      totalChunks++;
      chunks.push({
        id: `chunk-${chunkId++}`,
        kind: "diff-file",
        label: filePath,
        text: fullText,
        source: filePath,
        truncated: false,
      });
    } else {
      const hunkChunks = splitBodyByHunk(section.body, filePath);
      for (const hc of hunkChunks) {
        const text = hc.hunkHeader + hc.content;
        totalChunks++;
        chunks.push({
          id: `chunk-${chunkId++}`,
          kind: "diff-hunk",
          label: `${filePath} (hunk)`,
          text,
          source: filePath,
          truncated: text.length > maxCharsPerFile,
        });
      }
    }
  }

  logger.debug("chunkDiff result", {
    sections: fileSections.length,
    chunks: chunks.length,
    totalChunks,
    omitted: omitted.length,
  });

  return {
    chunks,
    meta: {
      total_chunks: totalChunks,
      analyzed_chunks: chunks.length,
      omitted_chunks: omitted.length,
      omitted,
      input_truncated: omitted.length > 0,
      chunking_strategy: "diff-by-file-then-hunk",
    },
  };
}
