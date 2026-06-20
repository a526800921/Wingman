/**
 * Unified chunking types for diff, command output, and text splitting.
 * Used by both model-path and fallback-path implementations.
 */

export type ChunkKind = "diff-file" | "diff-hunk" | "text-section" | "command-section";

export interface InputChunk {
  id: string;
  kind: ChunkKind;
  label: string;
  text: string;
  start_line?: number;
  end_line?: number;
  source?: string;       // file path, command name, etc.
  truncated: boolean;
}

export interface OmittedChunk {
  id: string;
  label: string;
  source?: string;
  reason: string;
  start_line?: number;
  end_line?: number;
}

export interface ChunkMeta {
  total_chunks: number;
  analyzed_chunks: number;
  omitted_chunks: number;
  omitted: OmittedChunk[];
  input_truncated: boolean;
  chunking_strategy: string;
}
