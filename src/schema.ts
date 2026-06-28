/**
 * 所有 MCP tool 的输入 / 输出 schema 及共享类型。
 * 使用 Zod ^3.23.0 进行运行时校验 —— 拒绝未预期字段 (.strict())。
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// 共享类型
// ---------------------------------------------------------------------------

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const EvidenceSchema = z.strictObject({
  claim: z.string(),
  source: z.string(),
  confidence: ConfidenceSchema.optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const UncertaintySchema = z.strictObject({
  topic: z.string(),
  reason: z.string(),
  suggested_verification: z.string().optional(),
});
export type Uncertainty = z.infer<typeof UncertaintySchema>;

// ── Unified analysis status ───────────────────────────────

export const AnalysisStatusSchema = z.enum(["complete", "partial", "incomplete"]);
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;

export const ReportedTotalsSchema = z.strictObject({
  failures: z.number().int().nonnegative().optional(),
  errors: z.number().int().nonnegative().optional(),
  warnings: z.number().int().nonnegative().optional(),
  failed_files: z.number().int().nonnegative().optional(),
});

export const ResultMetaSchema = z.strictObject({
  provider: z.string().optional(),
  model: z.string(),
  tokens_used: z.number().int().nonnegative().optional(),
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  input_truncated: z.boolean(),
  fallback_used: z.boolean(),
  // P0: unified reliability semantics
  analysis_status: AnalysisStatusSchema.optional(),
  model_attempted: z.boolean().optional(),
  model_skip_reason: z.string().optional(),
  model_failure_reason: z.string().optional(),
  // Step 9: unified diagnostic fields (TranslateBar report reliability)
  model_used: z.boolean().optional(),
  analysis_mode: z.enum(["model_analysis", "heuristic_fallback", "mixed", "unsupported"]).optional(),
  confidence: ConfidenceSchema.optional(),
  limitations: z.array(z.string()).optional(),
  // MCP Tool Feedback Loop: caller-facing identifiers
  trace_id: z.string().optional(),
  tool_name: z.string().optional(),
});
export type ResultMeta = z.infer<typeof ResultMetaSchema>;

// ---------------------------------------------------------------------------
// aux_summarize_file 专用类型
// ---------------------------------------------------------------------------

export const ImportantSymbolSchema = z.strictObject({
  name: z.string(),
  kind: z.enum([
    "function",
    "class",
    "struct",
    "interface",
    "type",
    "const",
    "enum",
    "unknown",
  ]),
  role: z.string(),
  location: z.string().optional(),
});
export type ImportantSymbol = z.infer<typeof ImportantSymbolSchema>;

// ---------------------------------------------------------------------------
// aux_review_diff 专用类型
// ---------------------------------------------------------------------------

export const PossibleRiskSchema = z.strictObject({
  risk: z.string(),
  severity: SeveritySchema,
  location: z.string().optional(),
  explanation: z.string().optional(),
  evidence: z.string().optional(),
  introduced_by_diff: z.boolean().optional(),
  confidence: ConfidenceSchema.optional(),
});
export type PossibleRisk = z.infer<typeof PossibleRiskSchema>;

// ---------------------------------------------------------------------------
// 复合输出公共字段（is_authoritative + _meta）
// 各输出 schema 通过 .merge() 组合以保持 DRY
// ---------------------------------------------------------------------------

const authoritativeMarker = z.strictObject({
  is_authoritative: z.literal(false),
});

// ---------------------------------------------------------------------------
// 输入 schemas
// ---------------------------------------------------------------------------

const maxCharsField = (defaultVal: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(defaultVal)
    .optional();

export const SummarizeFileInput = z.strictObject({
  path: z.string().min(1),
  focus: z.string().optional(),
  max_chars: maxCharsField(50_000, 200_000),
});
export type SummarizeFileInput = z.infer<typeof SummarizeFileInput>;

export const CompressTextInput = z.strictObject({
  label: z.string().min(1),
  text: z.string().min(1),
  focus: z.string().optional(),
  max_chars: maxCharsField(80_000, 300_000),
});
export type CompressTextInput = z.infer<typeof CompressTextInput>;

export const ReviewDiffInput = z.strictObject({
  diff: z.string().min(1),
  focus: z.string().optional(),
  max_chars: maxCharsField(60_000, 200_000),
});
export type ReviewDiffInput = z.infer<typeof ReviewDiffInput>;

export const ImportantSectionSchema = z.strictObject({
  heading: z.string(),
  role: z.string(),
  location: z.string().optional(),
});
export type ImportantSection = z.infer<typeof ImportantSectionSchema>;

export const TestCaseSchema = z.strictObject({
  name: z.string(),
  behavior: z.string(),
  location: z.string().optional(),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const FileKindSchema = z.enum([
  "code",
  "markdown",
  "text",
  "test",
  "unknown",
]);
export type FileKind = z.infer<typeof FileKindSchema>;

// Heuristic signal (used by multiple tools)
export const HeuristicSignalSchema = z.strictObject({
  kind: z.string(),
  location: z.string().optional(),
  evidence: z.string(),
  confidence: z.enum(["low", "medium"]),
});
export type HeuristicSignal = z.infer<typeof HeuristicSignalSchema>;

// ---------------------------------------------------------------------------
// 输出 schemas
// ---------------------------------------------------------------------------

export const SummarizeFileOutput = authoritativeMarker.merge(
  z.strictObject({
    analysis_status: AnalysisStatusSchema.default("complete"),
    summary: z.string(),
    important_symbols: z.array(ImportantSymbolSchema),
    evidence: z.array(EvidenceSchema),
    uncertainties: z.array(UncertaintySchema),
    must_verify_in_source: z.boolean(),
    important_sections: z.array(ImportantSectionSchema).optional(),
    test_cases: z.array(TestCaseSchema).optional(),
    covered_behaviors: z.array(z.string()).optional(),
    file_kind: FileKindSchema.optional(),
    heuristic_signals: z.array(HeuristicSignalSchema).optional(),
    _meta: ResultMetaSchema,
  }),
);
export type SummarizeFileOutput = z.infer<typeof SummarizeFileOutput>;

export const CompressTextOutput = authoritativeMarker.merge(
  z.strictObject({
    analysis_status: AnalysisStatusSchema.default("complete"),
    summary: z.string(),
    key_facts: z.array(z.string()),
    discarded_or_low_confidence: z.array(z.string()),
    must_verify_in_source: z.boolean(),
    _meta: ResultMetaSchema,
  }),
);
export type CompressTextOutput = z.infer<typeof CompressTextOutput>;

export const ReviewDiffOutput = authoritativeMarker.merge(
  z.strictObject({
    analysis_status: AnalysisStatusSchema.default("complete"),
    change_summary: z.string(),
    possible_risks: z.array(PossibleRiskSchema),
    heuristic_signals: z.array(HeuristicSignalSchema).optional(),
    suggested_source_checks: z.array(z.string()),
    suggested_tests: z.array(z.string()),
    uncertainties: z.array(UncertaintySchema),
    must_verify_in_source: z.boolean().optional(),
    _meta: ResultMetaSchema,
  }),
);
export type ReviewDiffOutput = z.infer<typeof ReviewDiffOutput>;

// ---------------------------------------------------------------------------
// aux_review_diff_by_file 专用类型
// ---------------------------------------------------------------------------

export const DiffFindingSchema = z.strictObject({
  risk: z.string(),
  severity: SeveritySchema,
  file: z.string(),
  hunk: z.string().optional(),
  location: z.string().optional(),
  explanation: z.string().optional(),
  evidence: z.string(),
  introduced_by_diff: z.boolean().optional(),
  confidence: ConfidenceSchema,
});
export type DiffFinding = z.infer<typeof DiffFindingSchema>;

export const FileReviewSchema = z.strictObject({
  file: z.string(),
  change_summary: z.string(),
  findings: z.array(DiffFindingSchema),
  suggested_source_checks: z.array(z.string()),
  suggested_tests: z.array(z.string()),
  uncertainties: z.array(UncertaintySchema),
});
export type FileReviewZod = z.infer<typeof FileReviewSchema>;

export const OmittedFileSchema = z.strictObject({
  file: z.string(),
  reason: z.string(),
});
export type OmittedFileZod = z.infer<typeof OmittedFileSchema>;

export const OmittedChunkSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  source: z.string().optional(),
  reason: z.string(),
  start_line: z.number().int().nonnegative().optional(),
  end_line: z.number().int().nonnegative().optional(),
});

export const ChunkMetaSchema = z.strictObject({
  total_chunks: z.number().int().nonnegative(),
  analyzed_chunks: z.number().int().nonnegative(),
  omitted_chunks: z.number().int().nonnegative(),
  omitted: z.array(OmittedChunkSchema),
  input_truncated: z.boolean(),
  chunking_strategy: z.string(),
});
export type ChunkMetaZod = z.infer<typeof ChunkMetaSchema>;

export const ReviewDiffByFileInput = z.strictObject({
  diff: z.string().min(1),
  focus: z.string().optional(),
  max_chars_per_file: z.number().int().min(1).max(200_000).default(40_000).optional(),
  max_files: z.number().int().min(1).max(100).default(30).optional(),
});
export type ReviewDiffByFileInput = z.infer<typeof ReviewDiffByFileInput>;

export const ReviewDiffByFileOutput = authoritativeMarker.merge(
  z.strictObject({
    analysis_status: AnalysisStatusSchema.default("complete"),
    overall_summary: z.string(),
    files: z.array(FileReviewSchema),
    top_risks: z.array(DiffFindingSchema),
    omitted_files: z.array(OmittedFileSchema),
    heuristic_signals: z.array(HeuristicSignalSchema).optional(),
    _meta: z.strictObject({
      provider: z.string().optional(),
      model: z.string(),
      tokens_used: z.number().int().nonnegative().optional(),
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      input_truncated: z.boolean(),
      fallback_used: z.boolean(),
      chunking: ChunkMetaSchema,
      // P0: unified reliability semantics
      analysis_status: AnalysisStatusSchema.optional(),
      model_attempted: z.boolean().optional(),
      model_skip_reason: z.string().optional(),
      model_failure_reason: z.string().optional(),
      // Step 9: unified diagnostic fields (TranslateBar report reliability)
      model_used: z.boolean().optional(),
      analysis_mode: z.enum(["model_analysis", "heuristic_fallback", "mixed", "unsupported"]).optional(),
      confidence: ConfidenceSchema.optional(),
      limitations: z.array(z.string()).optional(),
      // Phase 2: number of files included in aggregated output
      files_analyzed: z.number().int().nonnegative().optional(),
      files_omitted: z.number().int().nonnegative().optional(),
      // MCP Tool Feedback Loop: caller-facing identifiers
      trace_id: z.string().optional(),
      tool_name: z.string().optional(),
    }),
  }),
);
export type ReviewDiffByFileOutput = z.infer<typeof ReviewDiffByFileOutput>;

// ---------------------------------------------------------------------------
// aux_compress_command_output 专用类型
// ---------------------------------------------------------------------------

export const CommandOutputFindingSchema = z.strictObject({
  kind: z.enum(["test_failure", "type_error", "lint_error", "build_error", "runtime_exception", "warning", "info", "unknown", "test_success", "build_success"]),
  message: z.string(),
  error_code: z.string().optional(),
  rule_id: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
  evidence: z.string(),
  confidence: ConfidenceSchema,
  first_seen_index: z.number().int().nonnegative().optional(),
});
export type CommandOutputFindingZod = z.infer<typeof CommandOutputFindingSchema>;

export const RepeatedErrorSchema = z.strictObject({
  message: z.string(),
  count: z.number().int().positive(),
  examples: z.array(z.string()),
});

export const CompressCommandOutputInput = z.strictObject({
  command: z.string().optional(),
  output: z.string().min(1),
  exit_code: z.number().int().optional(),
  focus: z.string().optional(),
  max_chars: z.number().int().min(1).max(300_000).default(120_000).optional(),
  analysis_mode: z.enum(["model_first", "auto", "deterministic_only"]).default("model_first").optional(),
});
export type CompressCommandOutputInput = z.infer<typeof CompressCommandOutputInput>;

export const CompressCommandOutputOutput = authoritativeMarker.merge(
  z.strictObject({
    summary: z.string(),
    analysis_status: AnalysisStatusSchema,
    first_failure: CommandOutputFindingSchema.nullable().optional(),
    primary_actionable_failure: CommandOutputFindingSchema.nullable().optional(),
    findings: z.array(CommandOutputFindingSchema),
    repeated_errors: z.array(RepeatedErrorSchema),
    suggested_source_checks: z.array(z.string()),
    suggested_next_commands: z.array(z.string()),
    discarded_or_low_confidence: z.array(z.string()),
    uncertainties: z.array(z.string()).optional(),
    reported_totals: ReportedTotalsSchema.optional(),
    _meta: z.strictObject({
      provider: z.string().optional(),
      model: z.string(),
      tokens_used: z.number().int().nonnegative().optional(),
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      input_truncated: z.boolean(),
      fallback_used: z.boolean(),
      chunking: ChunkMetaSchema,
      // Analysis status metadata
      analysis_status: AnalysisStatusSchema.optional(),
      model_attempted: z.boolean().optional(),
      model_skip_reason: z.string().optional(),
      model_failure_reason: z.string().optional(),
      // Step 9: unified diagnostic fields (TranslateBar report reliability)
      model_used: z.boolean().optional(),
      analysis_mode: z.enum(["model_analysis", "heuristic_fallback", "mixed", "unsupported"]).optional(),
      confidence: ConfidenceSchema.optional(),
      limitations: z.array(z.string()).optional(),
      // P0: response contract recovery
      model_response_status: z.string().optional(),
      model_call_attempts: z.number().int().nonnegative().optional(),
      // Canonical counts
      diagnostics_parsed: z.number().int().nonnegative().optional(),
      findings_retained: z.number().int().nonnegative().optional(),
      verified_findings: z.number().int().nonnegative().optional(),
      partial_findings: z.number().int().nonnegative().optional(),
      unverified_findings: z.number().int().nonnegative().optional(),
      // Batch/model metadata
      candidate_batches: z.number().int().nonnegative().optional(),
      batches_sent: z.number().int().nonnegative().optional(),
      batches_succeeded: z.number().int().nonnegative().optional(),
      batches_failed: z.number().int().nonnegative().optional(),
      batches_omitted_by_budget: z.number().int().nonnegative().optional(),
      model_findings_received: z.number().int().nonnegative().optional(),
      model_findings_rejected: z.number().int().nonnegative().optional(),
      model_enhancements_applied: z.number().int().nonnegative().optional(),
      unknown_diagnostic_ids: z.number().int().nonnegative().optional(),
      // Model-first specific
      detector_hint: z.string().optional(),
      model_detected_kind: z.string().optional(),
      kind_mismatch: z.boolean().optional(),
      // MCP Tool Feedback Loop: caller-facing identifiers
      trace_id: z.string().optional(),
      tool_name: z.string().optional(),
    }),
  }),
);
export type CompressCommandOutputOutput = z.infer<typeof CompressCommandOutputOutput>;

// ---------------------------------------------------------------------------
// Phase 2: 模型响应 schemas（内部使用，非对外输出）
// 模型每次返回零到多个 finding，handler 将其合并到最终输出
// ---------------------------------------------------------------------------

export const ModelCommandFindingSchema = z.strictObject({
  diagnostic_id: z.string().optional(),
  kind: CommandOutputFindingSchema.shape.kind.optional(),
  message: z.string().optional(),
  confidence: ConfidenceSchema.optional(),
  actionability: z.enum(["high", "medium", "low"]).optional(),
});
export type ModelCommandFinding = z.infer<typeof ModelCommandFindingSchema>;

export const ModelCommandOutputResponseSchema = z.strictObject({
  findings: z.array(ModelCommandFindingSchema).max(5),
});

export const ModelDiffFindingSchema = z.strictObject({
  risk: z.string().optional(),
  severity: SeveritySchema.optional(),
  file: z.string(),
  hunk: z.string().optional(),
  location: z.string().optional(),
  explanation: z.string().optional(),
  evidence: z.string(),
  introduced_by_diff: z.boolean().optional(),
  confidence: ConfidenceSchema.optional(),
});
export type ModelDiffFinding = z.infer<typeof ModelDiffFindingSchema>;

export const ModelDiffReviewResponseSchema = z.strictObject({
  findings: z.array(ModelDiffFindingSchema).max(5),
});

// ── Model-first response (for compress_command_output) ────

export const ModelFirstFindingSchema = z.strictObject({
  finding_id: z.string(),
  kind: CommandOutputFindingSchema.shape.kind,
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
  error_code: z.string().optional(),
  test_name: z.string().optional(),
  evidence: z.string(),
  confidence: ConfidenceSchema,
});
export type ModelFirstFinding = z.infer<typeof ModelFirstFindingSchema>;

export const ModelFirstResponseSchema = z.strictObject({
  detected_kind: z.enum(["test_output", "tsc_error", "eslint_output", "build_output", "stack_trace", "generic_log"]),
  summary: z.string().optional(),
  findings: z.array(ModelFirstFindingSchema).max(20),
  reported_totals: z.strictObject({
    failures: z.number().int().nonnegative().optional(),
    errors: z.number().int().nonnegative().optional(),
    warnings: z.number().int().nonnegative().optional(),
    failed_files: z.number().int().nonnegative().optional(),
  }).optional(),
  uncertainties: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// aux_report_tool_feedback 专用类型
// ---------------------------------------------------------------------------

export const ToolFeedbackIssueCategorySchema = z.enum([
  "wrong_kind",
  "self_contradiction",
  "missing_evidence",
  "hallucination",
  "overconfident_fallback",
  "schema_confusing",
  "low_signal_output",
  "missing_context",
  "date_error",
  "other",
]);
export type ToolFeedbackIssueCategory = z.infer<typeof ToolFeedbackIssueCategorySchema>;

export const ToolFeedbackInputSchema = z.strictObject({
  tool_name: z.string().min(1),
  trace_id: z.string().optional(),
  issue_category: ToolFeedbackIssueCategorySchema,
  severity: SeveritySchema,
  summary: z.string().min(1).max(500),
  evidence: z.string().max(1000).optional(),
  expected_behavior: z.string().max(500).optional(),
  actual_behavior: z.string().max(500).optional(),
  confidence: ConfidenceSchema,
}).superRefine((data, ctx) => {
  const textFields = [
    data.summary,
    data.evidence,
    data.expected_behavior,
    data.actual_behavior,
  ];
  for (const field of textFields) {
    if (!field) continue;
    // Reject API key patterns (e.g. sk-abc123...)
    if (/sk-[a-zA-Z0-9]{10,}/.test(field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sensitive content rejected: API key pattern (sk-...) detected in feedback text",
        fatal: true,
      });
      return;
    }
    // Reject Authorization headers and Bearer tokens
    if (/Authorization:\s*Bearer/i.test(field) || /Bearer\s+[a-zA-Z0-9._\-]+/i.test(field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sensitive content rejected: Authorization header or Bearer token detected in feedback text",
        fatal: true,
      });
      return;
    }
  }
});
export type ToolFeedbackInput = z.infer<typeof ToolFeedbackInputSchema>;

export const ToolFeedbackOutputSchema = z.strictObject({
  recorded: z.boolean(),
  feedback_id: z.string(),
  log_file: z.string().nullable(),
  is_authoritative: z.literal(false),
});
export type ToolFeedbackOutput = z.infer<typeof ToolFeedbackOutputSchema>;

// ---------------------------------------------------------------------------
// 输入 / 输出 schema 注册表（供 validateInput / validateOutput 使用）
// ---------------------------------------------------------------------------

type ToolName = "aux_summarize_file" | "aux_compress_text" | "aux_review_diff" | "aux_review_diff_by_file" | "aux_compress_command_output" | "aux_report_tool_feedback";

const inputSchemas: Record<ToolName, z.ZodTypeAny> = {
  aux_summarize_file: SummarizeFileInput,
  aux_compress_text: CompressTextInput,
  aux_review_diff: ReviewDiffInput,
  aux_review_diff_by_file: ReviewDiffByFileInput,
  aux_compress_command_output: CompressCommandOutputInput,
  aux_report_tool_feedback: ToolFeedbackInputSchema,
};

const outputSchemas: Record<ToolName, z.ZodTypeAny> = {
  aux_summarize_file: SummarizeFileOutput,
  aux_compress_text: CompressTextOutput,
  aux_review_diff: ReviewDiffOutput,
  aux_review_diff_by_file: ReviewDiffByFileOutput,
  aux_compress_command_output: CompressCommandOutputOutput,
  aux_report_tool_feedback: ToolFeedbackOutputSchema,
};

// ---------------------------------------------------------------------------
// 验证辅助函数
// ---------------------------------------------------------------------------

type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function safeParse<T>(
  schema: z.ZodType<T>,
  data: unknown,
): ValidationResult<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: result.error.message };
}

export function validateInput(
  toolName: string,
  data: unknown,
): ValidationResult<unknown> {
  const schema = inputSchemas[toolName as ToolName];
  if (!schema) {
    return { ok: false, error: `Unknown tool: ${toolName}` };
  }
  return safeParse(schema, data);
}

export function validateOutput(
  toolName: string,
  data: unknown,
): ValidationResult<unknown> {
  const schema = outputSchemas[toolName as ToolName];
  if (!schema) {
    return { ok: false, error: `Unknown tool: ${toolName}` };
  }
  return safeParse(schema, data);
}
