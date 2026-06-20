/**
 * Chunk merge — deduplicate, merge same-file findings, sort by severity.
 */

import type { ChunkMeta } from "./types.js";

// ---------------------------------------------------------------------------
// Shared finding identity for deduplication
// ---------------------------------------------------------------------------

export interface FindingIdentity {
  normalizedRisk: string;
  file?: string;
  location?: string;
  normalizedEvidence: string;
}

export function buildFindingIdentity(finding: {
  risk?: string;
  kind?: string;
  file?: string;
  location?: string;
  evidence?: string;
}): FindingIdentity {
  const normalizedRisk = (finding.risk ?? finding.kind ?? "").toLowerCase().trim();
  const normalizedEvidence = (finding.evidence ?? "").toLowerCase().trim().slice(0, 200);
  return {
    normalizedRisk,
    file: finding.file,
    location: finding.location,
    normalizedEvidence,
  };
}

export function isSameFinding(a: FindingIdentity, b: FindingIdentity): boolean {
  if (a.normalizedRisk !== b.normalizedRisk) return false;
  if (a.file && b.file && a.file !== b.file) return false;
  if (a.location && b.location && a.location !== b.location) return false;
  if (a.normalizedEvidence && b.normalizedEvidence) {
    const shorter = a.normalizedEvidence.length < b.normalizedEvidence.length ? a.normalizedEvidence : b.normalizedEvidence;
    const longer = shorter === a.normalizedEvidence ? b.normalizedEvidence : a.normalizedEvidence;
    if (!longer.includes(shorter)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Severity / confidence ordering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

const CONFIDENCE_ORDER: Record<string, number> = {
  high: 0, medium: 1, low: 2,
};

const ACTIONABILITY_ORDER: Record<string, number> = {
  high: 0, medium: 1, low: 2,
};

export function sortFindings<T extends {
  severity?: string;
  confidence?: string;
  introduced_by_diff?: boolean;
  first_seen_index?: number;
  actionability?: string;
}>(findings: T[]): T[] {
  return [...findings].sort((a, b) => {
    // Actionability first (for command output findings)
    if (a.actionability || b.actionability) {
      const actA = ACTIONABILITY_ORDER[a.actionability ?? "low"] ?? 99;
      const actB = ACTIONABILITY_ORDER[b.actionability ?? "low"] ?? 99;
      if (actA !== actB) return actA - actB;
    }
    const sevA = SEVERITY_ORDER[a.severity ?? "low"] ?? 99;
    const sevB = SEVERITY_ORDER[b.severity ?? "low"] ?? 99;
    if (sevA !== sevB) return sevA - sevB;
    const confA = CONFIDENCE_ORDER[a.confidence ?? "low"] ?? 99;
    const confB = CONFIDENCE_ORDER[b.confidence ?? "low"] ?? 99;
    if (confA !== confB) return confA - confB;
    if (a.introduced_by_diff && !b.introduced_by_diff) return -1;
    if (!a.introduced_by_diff && b.introduced_by_diff) return 1;
    return (a.first_seen_index ?? 0) - (b.first_seen_index ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

export function deduplicateFindings<T extends {
  risk?: string;
  kind?: string;
  file?: string;
  location?: string;
  evidence?: string;
  severity?: string;
}>(
  findings: T[],
  getIdentity: (f: T) => FindingIdentity = buildFindingIdentity,
): T[] {
  const seen: FindingIdentity[] = [];
  const result: T[] = [];
  for (const f of findings) {
    const id = getIdentity(f);
    const duplicate = seen.findIndex((s) => isSameFinding(s, id));
    if (duplicate >= 0) {
      const existingSev = SEVERITY_ORDER[result[duplicate].severity ?? "low"] ?? 99;
      const newSev = SEVERITY_ORDER[f.severity ?? "low"] ?? 99;
      if (newSev < existingSev) {
        result[duplicate] = f;
        seen[duplicate] = id;
      }
    } else {
      seen.push(id);
      result.push(f);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Command output finding identity (kind + message + error_code based)
// ---------------------------------------------------------------------------

export interface CommandFindingIdentity {
  normalizedKind: string;
  normalizedMessage: string;
  file?: string;
  errorCode?: string;
}

export function buildCommandFindingIdentity(finding: {
  kind?: string;
  message?: string;
  file?: string;
  error_code?: string;
}): CommandFindingIdentity {
  return {
    normalizedKind: (finding.kind ?? "").toLowerCase().trim(),
    normalizedMessage: (finding.message ?? "").toLowerCase().trim().slice(0, 200),
    file: finding.file,
    errorCode: finding.error_code,
  };
}

export function isSameCommandFinding(a: CommandFindingIdentity, b: CommandFindingIdentity): boolean {
  if (a.normalizedKind !== b.normalizedKind) return false;
  if (a.file && b.file && a.file !== b.file) return false;
  if (a.errorCode && b.errorCode && a.errorCode !== b.errorCode) return false;
  const shorter = a.normalizedMessage.length < b.normalizedMessage.length
    ? a.normalizedMessage : b.normalizedMessage;
  const longer = shorter === a.normalizedMessage ? b.normalizedMessage : a.normalizedMessage;
  if (shorter && longer && !longer.includes(shorter)) return false;
  return true;
}

/**
 * Deduplicate command output findings.
 * Keeps the first occurrence preserving order; upgrades severity/confidence
 * when a duplicate has a higher-confidence classification.
 */
export function deduplicateCommandFindings<T extends {
  kind?: string;
  message?: string;
  file?: string;
  error_code?: string;
  confidence?: string;
}>(
  findings: T[],
  getIdentity: (f: T) => CommandFindingIdentity = buildCommandFindingIdentity,
): T[] {
  const seen: CommandFindingIdentity[] = [];
  const result: T[] = [];
  const CONF_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

  for (const f of findings) {
    const id = getIdentity(f);
    const dupIdx = seen.findIndex((s) => isSameCommandFinding(s, id));
    if (dupIdx >= 0) {
      const existConf = CONF_ORDER[result[dupIdx].confidence ?? "low"] ?? 99;
      const newConf = CONF_ORDER[f.confidence ?? "low"] ?? 99;
      if (newConf < existConf) {
        result[dupIdx] = f;
        seen[dupIdx] = id;
      }
    } else {
      seen.push(id);
      result.push(f);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Merge chunk metas
// ---------------------------------------------------------------------------

export function mergeChunkMetas(metas: ChunkMeta[]): ChunkMeta {
  const merged: ChunkMeta = {
    total_chunks: 0,
    analyzed_chunks: 0,
    omitted_chunks: 0,
    omitted: [],
    input_truncated: false,
    chunking_strategy: metas[0]?.chunking_strategy ?? "merged",
  };
  const strategies = new Set<string>();
  for (const m of metas) {
    merged.total_chunks += m.total_chunks;
    merged.analyzed_chunks += m.analyzed_chunks;
    merged.omitted_chunks += m.omitted_chunks;
    merged.omitted.push(...m.omitted);
    if (m.input_truncated) merged.input_truncated = true;
    strategies.add(m.chunking_strategy);
  }
  merged.chunking_strategy = [...strategies].join("+");
  return merged;
}
