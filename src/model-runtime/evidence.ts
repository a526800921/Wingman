/**
 * Shared evidence verification — checks that model-returned evidence
 * exists in the original input or batch payload.
 */

import type { EvidenceVerdict } from "./types.js";

/**
 * Verify that `evidence` is an exact substring of `inputText`.
 *
 * Returns:
 *   "verified"   — every line of evidence found in input
 *   "partial"    — at least 50% of evidence lines found
 *   "unverified" — no or minimal match
 */
export function verifyEvidence(evidence: string, inputText: string): EvidenceVerdict {
  if (!evidence || evidence.trim().length === 0) return "unverified";

  // Exact substring match — best case
  if (inputText.includes(evidence)) return "verified";

  // Line-by-line: any line found?
  const lines = evidence.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return "unverified";

  const matchedLines = lines.filter(l => inputText.includes(l));
  const ratio = matchedLines.length / lines.length;

  if (ratio >= 0.8) return "verified";
  if (ratio >= 0.5) return "partial";
  return "unverified";
}

/**
 * Verify that evidence is a substring of any of the provided batch texts.
 * Used when model input was split across multiple batches.
 */
export function verifyEvidenceInBatches(
  evidence: string,
  batchTexts: string[],
): EvidenceVerdict {
  for (const text of batchTexts) {
    const result = verifyEvidence(evidence, text);
    if (result === "verified") return "verified";
  }
  return "unverified";
}
