/**
 * Diagnostic domain types.
 *
 * CommandDiagnostic is the internal representation of a parsed error/warning
 * block from command output (tsc, eslint, test, etc.). It bridges raw parsing
 * and the public CommandOutputFinding schema.
 */

export type DiagnosticKind =
  | "type_error"
  | "lint_error"
  | "test_failure"
  | "build_error"
  | "runtime_exception"
  | "warning"
  | "info"
  | "unknown";

export type SourceKind = "project" | "test" | "generated" | "dependency" | "unknown";

export type Actionability = "high" | "medium" | "low";

export interface CommandDiagnostic {
  /**
   * Stable deterministic ID derived from kind + file + line + error_code.
   * Used for model cross-reference — the model echoes this id back to map
   * its findings to the pre-parsed diagnostics.
   */
  id: string;
  kind: DiagnosticKind;
  source_kind: SourceKind;
  actionability: Actionability;
  file?: string;
  line?: number;
  column?: number;
  error_code?: string;
  rule_id?: string;
  /** The primary error message (first line of the diagnostic header). */
  headline: string;
  /** Supporting detail lines (type expansions, related info, code frames). */
  details: string[];
  /** Full original text of this diagnostic block (for evidence). */
  evidence: string;
  /** Byte offset of this diagnostic's first line in the original (stripped) output. */
  first_seen_index: number;
  /** Parser confidence in the boundary detection. */
  parser_confidence: "high" | "medium" | "low";
  /** Whether the parser had to truncate this diagnostic (size limit hit). */
  truncated: boolean;
}
