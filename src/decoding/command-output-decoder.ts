/**
 * 模型响应解码器 — 纯函数，不依赖 ChatClient、命令类型或 parser。
 *
 * 将 modelFirstPath 中的 JSON 提取 + Schema 校验逻辑提取为可独立测试的纯函数。
 * 实现分层校验：envelope → 逐 finding 规范化 → 逐 finding 校验。
 */

import { extractJsonFromResponse } from "../prompts.js";
import { z } from "zod";
import type { ModelFirstFinding } from "../schema.js";

// ── Response status ────────────────────────────────────────

/** 模型响应解码状态：区分 transport / JSON / envelope / finding / empty 五类 */
export type ModelResponseStatus =
  | "valid"           // envelope + 所有 findings 合法
  | "partial_valid"   // envelope 合法，部分 finding 被拒绝
  | "empty"           // envelope 合法，findings 为空数组
  | "parse_failure"   // JSON.parse 或 extractJson 失败
  | "schema_failure"  // envelope 结构不合法（缺少 detected_kind 或 findings 非数组）
  | "transport_failure"; // HTTP/网络层失败（由调用方在 catch 中设置）

// ── Rejected issue ─────────────────────────────────────────

export interface RejectedIssue {
  /** findings 数组中的原始索引 */
  index: number;
  /** 简短的拒绝原因（字段路径 + 错误码，不含完整响应） */
  reason: string;
}

// ── Decoded result ─────────────────────────────────────────

export interface DecodedModelFirstResponse {
  status: ModelResponseStatus;
  detected_kind?: string;
  summary?: string;
  reported_totals?: Record<string, number>;
  uncertainties?: string[];
  /** 通过逐项校验的 findings */
  accepted_findings: ModelFirstFinding[];
  /** 被拒绝的 finding 索引和原因 */
  rejected_issues: RejectedIssue[];
}

// ── Known field sets for normalization ─────────────────────

const FINDING_KNOWN_FIELDS = new Set([
  "finding_id", "kind", "message", "file", "line", "column",
  "error_code", "test_name", "evidence", "confidence",
]);

const ENVELOPE_KNOWN_FIELDS = new Set([
  "detected_kind", "summary", "findings", "reported_totals", "uncertainties",
]);

/** Fields accepted in reported_totals — must match ReportedTotalsSchema */
const REPORTED_TOTALS_KNOWN_FIELDS = new Set([
  "failures", "errors", "warnings", "failed_files",
]);

// ── Relaxed finding schema (passthrough: allow extra fields) ─

const RelaxedFindingSchema = z.object({
  finding_id: z.string(),
  kind: z.enum([
    "test_failure", "type_error", "lint_error", "build_error",
    "runtime_exception", "warning", "info", "unknown",
  ]),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
  error_code: z.string().optional(),
  test_name: z.string().optional(),
  evidence: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
}).passthrough();

// ── Normalization helpers ──────────────────────────────────

/**
 * 递归规范化对象中的 null optional 值 → 删除键（Zod optional 期望 undefined，不是 null）。
 * 保留 required 字段的 null（Zod 会产生清晰的 "Expected string, received null" 错误）。
 * 只处理顶层键 — 不深入嵌套对象（findings 没有嵌套对象字段）。
 */
function normalizeOptionalNull(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null) {
      // 跳过 null — Zod optional 期望 undefined
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * 剥离未知字段，只保留 knownFields 集合中的键。
 * 返回 { cleaned, strippedCount }。
 */
function stripUnknownFields(
  obj: Record<string, unknown>,
  knownFields: Set<string>,
): { cleaned: Record<string, unknown>; strippedCount: number } {
  let strippedCount = 0;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (knownFields.has(key)) {
      cleaned[key] = value;
    } else {
      strippedCount++;
    }
  }
  return { cleaned, strippedCount };
}

// ── Main decode function ───────────────────────────────────

/**
 * 解码模型原始响应字符串为结构化结果。
 *
 * 分层校验顺序：
 * 1. JSON 提取 + 解析 → parse_failure
 * 2. Envelope 结构校验 → schema_failure
 * 3. 逐 finding 规范化 + 校验 → accepted / rejected
 *
 * 纯函数：不访问命令类型、ChatClient 或 parser。
 * 错误信息只保留字段路径、错误码和计数，不保留完整模型响应。
 */
export function decodeModelFirstResponse(raw: string): DecodedModelFirstResponse {
  // ── Layer 1: JSON extraction + parse ──────────────────
  let parsed: unknown;
  try {
    const jsonStr = extractJsonFromResponse(raw);
    parsed = JSON.parse(jsonStr);
  } catch {
    return {
      status: "parse_failure",
      accepted_findings: [],
      rejected_issues: [],
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      status: "schema_failure",
      accepted_findings: [],
      rejected_issues: [],
    };
  }

  const obj = parsed as Record<string, unknown>;

  // ── Layer 2: Envelope validation ──────────────────────
  if (typeof obj.detected_kind !== "string" || !Array.isArray(obj.findings)) {
    return {
      status: "schema_failure",
      accepted_findings: [],
      rejected_issues: [],
    };
  }

  // Normalize envelope-level optional fields
  const envelope = normalizeOptionalNull(obj);
  // Strip unknown fields from envelope
  const { cleaned: cleanEnvelope } = stripUnknownFields(envelope, ENVELOPE_KNOWN_FIELDS);

  const detected_kind = cleanEnvelope.detected_kind as string;
  const summary = typeof cleanEnvelope.summary === "string" ? cleanEnvelope.summary : undefined;
  const uncertainties = Array.isArray(cleanEnvelope.uncertainties)
    ? (cleanEnvelope.uncertainties as string[]).filter(u => typeof u === "string")
    : undefined;

  // Parse reported_totals if present — only accept known fields with integer values
  let reported_totals: Record<string, number> | undefined;
  if (typeof cleanEnvelope.reported_totals === "object" && cleanEnvelope.reported_totals !== null) {
    const rt = cleanEnvelope.reported_totals as Record<string, unknown>;
    reported_totals = {};
    for (const [k, v] of Object.entries(rt)) {
      if (
        REPORTED_TOTALS_KNOWN_FIELDS.has(k) &&
        typeof v === "number" &&
        Number.isInteger(v) &&
        Number.isFinite(v) &&
        v >= 0
      ) {
        reported_totals[k] = v;
      }
    }
    if (Object.keys(reported_totals).length === 0) reported_totals = undefined;
  }

  const rawFindings = obj.findings as unknown[];

  // ── Layer 3: Empty findings check ─────────────────────
  if (rawFindings.length === 0) {
    return {
      status: "empty",
      detected_kind,
      summary,
      reported_totals,
      uncertainties,
      accepted_findings: [],
      rejected_issues: [],
    };
  }

  // ── Layer 4: Per-finding validation ───────────────────
  const accepted_findings: ModelFirstFinding[] = [];
  const rejected_issues: RejectedIssue[] = [];

  for (let i = 0; i < rawFindings.length; i++) {
    const rawFinding = rawFindings[i];
    if (typeof rawFinding !== "object" || rawFinding === null) {
      rejected_issues.push({ index: i, reason: `not an object (type: ${typeof rawFinding})` });
      continue;
    }

    // Step 4a: Normalize null optional fields
    const normalized = normalizeOptionalNull(rawFinding as Record<string, unknown>);

    // Step 4b: Strip unknown fields
    const { cleaned, strippedCount } = stripUnknownFields(normalized, FINDING_KNOWN_FIELDS);

    // Step 4c: Validate with relaxed schema
    const result = RelaxedFindingSchema.safeParse(cleaned);
    if (result.success) {
      accepted_findings.push(result.data as ModelFirstFinding);
    } else {
      const fieldErrors = result.error.issues.map(issue =>
        `${issue.path.join(".") || "(root)"}: ${issue.message}`
      ).join("; ");
      rejected_issues.push({ index: i, reason: fieldErrors });
    }
  }

  // ── Determine final status ────────────────────────────
  const status: ModelResponseStatus =
    rejected_issues.length === 0 ? "valid" : "partial_valid";

  return {
    status,
    detected_kind,
    summary,
    reported_totals,
    uncertainties,
    accepted_findings,
    rejected_issues,
  };
}
