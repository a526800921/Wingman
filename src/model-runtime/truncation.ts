/**
 * Smart truncation — preserves both prefix AND suffix when input exceeds budget.
 *
 * Unlike naive prefix truncation (first N chars), this ensures tail content
 * (late file definitions, log root causes, doc conclusions) reaches the model.
 */

/**
 * Split text into prefix + suffix chunks, each within `budget` chars.
 * Ensures the model sees both the beginning and end of large files/texts.
 */
export function splitPrefixSuffix(
  text: string,
  budget: number,
  prefixRatio: number = 0.6,
): { prefix: string; suffix: string; truncated: boolean; omittedChars: number } {
  if (text.length <= budget) {
    return { prefix: text, suffix: "", truncated: false, omittedChars: 0 };
  }

  const prefixChars = Math.floor(budget * prefixRatio);
  const suffixChars = budget - prefixChars;

  // Find a clean boundary for the prefix (end at newline)
  let prefixEnd = prefixChars;
  if (prefixEnd < text.length) {
    const nextNewline = text.indexOf("\n", prefixEnd);
    if (nextNewline !== -1 && nextNewline - prefixEnd < 200) {
      prefixEnd = nextNewline + 1;
    }
  }

  // Find a clean boundary for the suffix start (start at newline)
  let suffixStart = text.length - suffixChars;
  if (suffixStart > 0) {
    const prevNewline = text.lastIndexOf("\n", suffixStart);
    if (prevNewline !== -1 && suffixStart - prevNewline < 200) {
      suffixStart = prevNewline + 1;
    }
  }

  const prefix = text.slice(0, prefixEnd);
  const suffix = text.slice(suffixStart);
  const omittedChars = text.length - prefix.length - suffix.length;

  return { prefix, suffix, truncated: true, omittedChars };
}

/**
 * Join prefix and suffix with a marker for model context.
 */
export function joinPrefixSuffix(
  prefix: string,
  suffix: string,
  omittedChars: number,
): string {
  if (!suffix) return prefix;
  return [
    prefix,
    "",
    `[... ${omittedChars} characters omitted ...]`,
    "",
    suffix,
  ].join("\n");
}
