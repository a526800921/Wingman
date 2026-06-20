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

export const ResultMetaSchema = z.strictObject({
  provider: z.string().optional(),
  model: z.string(),
  tokens_used: z.number().int().nonnegative().optional(),
  input_truncated: z.boolean(),
  fallback_used: z.boolean(),
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

// ---------------------------------------------------------------------------
// 输出 schemas
// ---------------------------------------------------------------------------

export const SummarizeFileOutput = authoritativeMarker.merge(
  z.strictObject({
    summary: z.string(),
    important_symbols: z.array(ImportantSymbolSchema),
    evidence: z.array(EvidenceSchema),
    uncertainties: z.array(UncertaintySchema),
    must_verify_in_source: z.boolean(),
    important_sections: z.array(ImportantSectionSchema).optional(),
    test_cases: z.array(TestCaseSchema).optional(),
    covered_behaviors: z.array(z.string()).optional(),
    file_kind: FileKindSchema.optional(),
    _meta: ResultMetaSchema,
  }),
);
export type SummarizeFileOutput = z.infer<typeof SummarizeFileOutput>;

export const CompressTextOutput = authoritativeMarker.merge(
  z.strictObject({
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
    change_summary: z.string(),
    possible_risks: z.array(PossibleRiskSchema),
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
    overall_summary: z.string(),
    files: z.array(FileReviewSchema),
    top_risks: z.array(DiffFindingSchema),
    omitted_files: z.array(OmittedFileSchema),
    _meta: z.strictObject({
      provider: z.string().optional(),
      model: z.string(),
      tokens_used: z.number().int().nonnegative().optional(),
      input_truncated: z.boolean(),
      fallback_used: z.boolean(),
      chunking: ChunkMetaSchema,
    }),
  }),
);
export type ReviewDiffByFileOutput = z.infer<typeof ReviewDiffByFileOutput>;

// ---------------------------------------------------------------------------
// 输入 / 输出 schema 注册表（供 validateInput / validateOutput 使用）
// ---------------------------------------------------------------------------

type ToolName = "aux_summarize_file" | "aux_compress_text" | "aux_review_diff" | "aux_review_diff_by_file";

const inputSchemas: Record<ToolName, z.ZodTypeAny> = {
  aux_summarize_file: SummarizeFileInput,
  aux_compress_text: CompressTextInput,
  aux_review_diff: ReviewDiffInput,
  aux_review_diff_by_file: ReviewDiffByFileInput,
};

const outputSchemas: Record<ToolName, z.ZodTypeAny> = {
  aux_summarize_file: SummarizeFileOutput,
  aux_compress_text: CompressTextOutput,
  aux_review_diff: ReviewDiffOutput,
  aux_review_diff_by_file: ReviewDiffByFileOutput,
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
