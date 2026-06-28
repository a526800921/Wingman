/**
 * Shared sanitization — single sanitizeEvidence for the entire codebase.
 *
 * Previously duplicated in:
 *   - src/tools/compress-command-output.ts
 *   - src/fallback/compress-command-output.ts
 */

/** Redact secrets, tokens, and credentials from evidence strings. */
export function sanitizeEvidence(text: string): string {
  return text
    .replace(/Bearer\s+[\w\-.]{20,}/gi, "Bearer ***REDACTED***")
    .replace(
      /(api[_-]?key|apikey|secret|token|password)\s*[:=]\s*['"]?[\w\-.]{8,}['"]?/gi,
      "$1=***REDACTED***",
    )
    .replace(/(https?:\/\/)[^:@]+:[^@]+@/g, "$1***:***@");
}
