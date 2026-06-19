/**
 * Heuristic-based diff reviewer.
 *
 * Analyses a unified diff WITHOUT calling any model API.  Relies on regex
 * pattern-matching to flag risky constructs (secrets, injection vectors, auth
 * bypasses, type-as-any escapes, etc.) and produces a structured
 * FallbackReviewResult suitable for downstream tooling or human triage.
 *
 * This is intentionally conservative – it has NO semantic understanding of the
 * codebase and will produce false positives.  The `is_authoritative` flag is
 * always `false`.
 */

import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FallbackRisk {
  risk: string;
  severity: "low" | "medium" | "high" | "critical";
  location?: string;
  explanation?: string;
}

export interface FallbackUncertainty {
  topic: string;
  reason: string;
  suggested_verification?: string;
}

export interface FallbackReviewResult {
  change_summary: string;
  possible_risks: FallbackRisk[];
  suggested_source_checks: string[];
  suggested_tests: string[];
  uncertainties: FallbackUncertainty[];
  is_authoritative: false;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 60_000;

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".class",
  ".jar",
  ".war",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether a file path looks like a binary asset. */
function isBinaryFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/** Estimate the line count of a function by grouping consecutive `+` lines. */
function maxConsecutiveAddedLines(addedLines: string[]): number {
  let max = 0;
  let run = 0;
  for (const line of addedLines) {
    if (/^\+[^+]/.test(line)) {
      run++;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return max;
}

/**
 * Split the diff into per-hunk segments so we can attribute findings to
 * approximate locations.
 */
interface HunkInfo {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  content: string;
}

function parseHunks(diff: string): HunkInfo[] {
  const hunkRegex = /^@@\s+-(\d+),?(\d*)\s+\+(\d+),?(\d*)\s+@@/gm;
  const matches: Array<{ start: number; end: number; m: RegExpExecArray }> = [];
  let match: RegExpExecArray | null;
  while ((match = hunkRegex.exec(diff)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, m: match });
  }
  const hunks: HunkInfo[] = [];
  for (let i = 0; i < matches.length; i++) {
    const { start, m } = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].start : diff.length;
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] ? Number(m[2]) : 1,
      newStart: Number(m[3]),
      newCount: m[4] ? Number(m[4]) : 1,
      content: diff.slice(start, end),
    });
  }
  return hunks;
}

/** Map a hunk index to a human-readable location string. */
function hunkLocation(hunk: HunkInfo, idx: number): string {
  return `hunk #${idx + 1} (line ~${hunk.newStart})`;
}

// ---------------------------------------------------------------------------
// Core: detect high-risk patterns
// ---------------------------------------------------------------------------

interface PatternResult {
  risks: FallbackRisk[];
  hasAuthChanges: boolean;
  hasSqlChanges: boolean;
  hasNewDeps: boolean;
  hasOnlyFormatting: boolean;
  hasOnlyComments: boolean;
  hasOnlyRenames: boolean;
}

function detectPatterns(
  diff: string,
  addedLines: string[],
  removedLines: string[],
  files: { old: string; new: string }[],
  hunks: HunkInfo[],
  truncated: boolean,
): PatternResult {
  const risks: FallbackRisk[] = [];
  let hasAuthChanges = false;
  let hasSqlChanges = false;
  let hasNewDeps = false;
  let hasOnlyFormatting = true;
  let hasOnlyComments = true;
  let hasOnlyRenames = true;

  const addedText = addedLines.join("\n");
  const removedText = removedLines.join("\n");
  const allText = addedText + "\n" + removedText;

  // Helper: find which hunk contains a given pattern (heuristic)
  function findHunkForPattern(pattern: RegExp, text: string): number {
    let best = -1;
    for (let i = 0; i < hunks.length; i++) {
      if (pattern.test(hunks[i].content)) {
        best = i;
        break;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------
  // CRITICAL/HIGH severity patterns
  // ------------------------------------------------------------------

  // Hardcoded secrets
  const secretPatterns: Record<string, RegExp> = {
    password: /password\s*[:=]\s*['"][^'"]+['"]/i,
    secret: /(secret|api_secret|client_secret)\s*[:=]\s*['"][^'"]+['"]/i,
    token: /(token|access_token|auth_token)\s*[:=]\s*['"][^'"]+['"]/i,
    api_key: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
    private_key: /private[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
    credentials: /credentials?\s*[:=]\s*['"][^'"]+['"]/i,
  };

  for (const [label, regex] of Object.entries(secretPatterns)) {
    if (regex.test(addedText) || regex.test(removedText)) {
      const hunkIdx = findHunkForPattern(regex, allText);
      const loc =
        hunkIdx >= 0 ? hunkLocation(hunks[hunkIdx], hunkIdx) : undefined;
      risks.push({
        risk: `Hardcoded ${label} detected in diff`,
        severity: "critical",
        location: loc,
        explanation: `A literal ${label} value appears to be embedded in source code. ` +
          `Secrets should be loaded from environment variables or a secure vault, never committed to version control.`,
      });
      hasOnlyFormatting = false;
      hasOnlyComments = false;
    }
  }

  // Auth bypass: removal of auth/authorization/permission/validate
  const authRemovalPattern =
    /\b(auth(?:enticate|orize|orisation)?|permission|validate)\b/gi;
  const authMatches = removedText.match(authRemovalPattern);
  if (authMatches && authMatches.length > 0) {
    hasAuthChanges = true;
    const unique = [...new Set(authMatches.map((m) => m.toLowerCase()))];
    const hunkIdx = findHunkForPattern(authRemovalPattern, removedText);
    const loc = hunkIdx >= 0 ? hunkLocation(hunks[hunkIdx], hunkIdx) : undefined;
    risks.push({
      risk: `Auth-related code removed: ${unique.join(", ")}`,
      severity: "high",
      location: loc,
      explanation:
        "Removal of authentication, authorization, or validation logic may weaken security. " +
        "Verify that any removed checks are either unnecessary or have been relocated.",
    });
    hasOnlyFormatting = false;
    hasOnlyComments = false;
  }

  // SQL injection: string concatenation with SQL keywords
  const sqlPattern =
    /\b(SELECT\s|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|DROP\s+DATABASE)\b/i;
  if (sqlPattern.test(addedText)) {
    // Check for string concatenation nearby
    const concatPattern = /['"]\s*[+]\s*|`\$\{|format\(|%s.*%s/;
    if (concatPattern.test(addedText)) {
      hasSqlChanges = true;
      const hunkIdx = findHunkForPattern(sqlPattern, addedText);
      const loc =
        hunkIdx >= 0 ? hunkLocation(hunks[hunkIdx], hunkIdx) : undefined;
      risks.push({
        risk: "Potential SQL injection via string concatenation",
        severity: "critical",
        location: loc,
        explanation:
          "SQL query built with string concatenation or template interpolation " +
          "detected near SQL keywords. Use parameterized queries (prepared statements) instead.",
      });
      hasOnlyFormatting = false;
      hasOnlyComments = false;
    }
  }

  // Command injection: exec, spawn, eval, system, shell_exec
  const cmdPattern = /\b(exec|spawn|eval|system|shell_exec|subprocess\.(?:run|call|Popen)|os\.system|child_process)\s*\(/g;
  if (cmdPattern.test(addedText)) {
    const hunkIdx = findHunkForPattern(cmdPattern, addedText);
    const loc = hunkIdx >= 0 ? hunkLocation(hunks[hunkIdx], hunkIdx) : undefined;
    // Check if input seems user-controlled (simple heuristic)
    const userInputPattern = /\b(req\.|request\.|params|query|body|input|argv|args\[)/i;
    const hasUserInput = userInputPattern.test(addedText);
    risks.push({
      risk: "Command execution call added" +
        (hasUserInput ? " with potential user-controlled input" : ""),
      severity: hasUserInput ? "critical" : "high",
      location: loc,
      explanation:
        "Shell command execution detected. " +
        (hasUserInput
          ? "User input appears to flow into the command — this is a command injection risk. " +
            "Sanitise inputs or avoid shell execution entirely."
          : "Ensure all arguments are statically defined and not derived from untrusted input."),
    });
    hasOnlyFormatting = false;
    hasOnlyComments = false;
  }

  // Empty catch blocks
  const emptyCatchPattern = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*(\/\/.*)?\s*\}/g;
  if (emptyCatchPattern.test(addedText)) {
    const hunkIdx = findHunkForPattern(emptyCatchPattern, addedText);
    const loc = hunkIdx >= 0 ? hunkLocation(hunks[hunkIdx], hunkIdx) : undefined;
    risks.push({
      risk: "Empty catch block(s) detected",
      severity: "high",
      location: loc,
      explanation:
        "Catch blocks with no error handling silently swallow exceptions, " +
        "making failures invisible and debugging difficult. Either handle, log, or re-throw the error.",
    });
    hasOnlyFormatting = false;
    hasOnlyComments = false;
  }

  // Disabled security flags
  const unsafePattern =
    /(--insecure|--no-verify|--allow-unstable|unsafe|--no-check-certificate|--disable-)?(?:security|ssl)/i;
  // More targeted: look for actual disabling flags
  const disableFlags = /(--insecure|--no-verify|--allow-unstable|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0)/i;
  if (disableFlags.test(addedText)) {
    const hunkIdx = findHunkForPattern(disableFlags, addedText);
    const loc = hunkIdx >= 0 ? hunkLocation(hunks[hunkIdx], hunkIdx) : undefined;
    risks.push({
      risk: "Security-disabling flags or settings detected",
      severity: "high",
      location: loc,
      explanation:
        "Flags like --insecure, --no-verify, or NODE_TLS_REJECT_UNAUTHORIZED=0 " +
        "disable security checks. This should only appear in local development or test harnesses.",
    });
    hasOnlyFormatting = false;
    hasOnlyComments = false;
  }

  // ------------------------------------------------------------------
  // MEDIUM severity patterns
  // ------------------------------------------------------------------

  // New dependencies
  const depFiles = [
    "package.json",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "Gemfile",
    "composer.json",
    "pyproject.toml",
    "build.gradle",
    "build.gradle.kts",
  ];
  for (const f of files) {
    const basename = (f.new || f.old).split("/").pop()?.toLowerCase() ?? "";
    if (depFiles.includes(basename)) {
      hasNewDeps = true;
      const addedDepLines = addedLines.filter(
        (l) =>
          l.startsWith('+    "') ||
          l.startsWith('+\t"') ||
          l.startsWith("+ ") ||
          l.startsWith("+\t"),
      );
      if (addedDepLines.length > 0) {
        risks.push({
          risk: `Dependency manifest changed: ${basename}`,
          severity: "medium",
          location: basename,
          explanation:
            "Adding, removing, or changing dependencies can introduce supply-chain risks, " +
            "breaking changes, or license incompatibilities. Run a dependency audit.",
        });
      }
      hasOnlyFormatting = false;
      hasOnlyComments = false;
    }
  }

  // Async without .catch
  const asyncPattern = /\basync\s+(?:function|\(|=>)/g;
  if (asyncPattern.test(addedText)) {
    const hasCatch = /\.catch\s*\(/.test(addedText) || /\btry\s*\{/.test(addedText);
    if (!hasCatch) {
      const hunkIdx = findHunkForPattern(asyncPattern, addedText);
      const loc =
        hunkIdx >= 0 ? hunkLocation(hunks[hunkIdx], hunkIdx) : undefined;
      risks.push({
        risk: "Async function added without error handling",
        severity: "medium",
        location: loc,
        explanation:
          "New async code does not appear to include .catch() or try/catch. " +
          "Unhandled promise rejections can crash the process in modern Node.",
      });
    }
    hasOnlyFormatting = false;
    hasOnlyComments = false;
  }

  // Type coercion escapes
  const typeEscapePatterns: Array<{ label: string; regex: RegExp }> = [
    { label: "as any", regex: /\bas\s+any\b/ },
    { label: "@ts-ignore", regex: /@ts-ignore/ },
    { label: "@ts-expect-error", regex: /@ts-expect-error/ },
    { label: "# type: ignore", regex: /#\s*type\s*:\s*ignore/ },
  ];
  for (const { label, regex } of typeEscapePatterns) {
    if (regex.test(addedText)) {
      const hunkIdx = findHunkForPattern(regex, addedText);
      const loc =
        hunkIdx >= 0 ? hunkLocation(hunks[hunkIdx], hunkIdx) : undefined;
      risks.push({
        risk: `Type escape hatch used: ${label}`,
        severity: "medium",
        location: loc,
        explanation:
          `"${label}" bypasses the type checker, hiding potential runtime errors. ` +
          "Prefer proper types or a TODO comment explaining why the escape is necessary.",
      });
    }
    hasOnlyFormatting = false;
    hasOnlyComments = false;
  }

  // Large new function
  const maxConsecutive = maxConsecutiveAddedLines(addedLines);
  if (maxConsecutive > 30) {
    // Find which hunk the large block is in
    let largeFuncHunk = -1;
    for (let i = 0; i < hunks.length; i++) {
      const hunkAdded = (hunks[i].content.match(/^\+[^+]/gm) || []);
      let run = 0;
      for (const line of hunkAdded) {
        if (/^\+[^+]/.test(line)) {
          run++;
          if (run > 30) {
            largeFuncHunk = i;
            break;
          }
        } else {
          run = 0;
        }
      }
      if (largeFuncHunk >= 0) break;
    }
    const loc =
      largeFuncHunk >= 0
        ? hunkLocation(hunks[largeFuncHunk], largeFuncHunk)
        : undefined;
    risks.push({
      risk: `Large block of added code (${maxConsecutive}+ consecutive lines)`,
      severity: "medium",
      location: loc,
      explanation:
        "A large new function or block was added. Consider whether it can be broken into " +
        "smaller, testable units. Large blocks are harder to review and more likely to contain bugs.",
    });
    hasOnlyFormatting = false;
    hasOnlyComments = false;
  }

  // Console.log/print left in
  const logPatterns: Array<{ label: string; regex: RegExp }> = [
    { label: "console.log", regex: /console\.(log|error|warn|debug|info)\(/ },
    { label: "print(", regex: /\bprint\s*\(/ },
    { label: "println!", regex: /println!/ },
    { label: "fmt.Println", regex: /fmt\.Println?\(/ },
  ];
  for (const { label, regex } of logPatterns) {
    if (regex.test(addedText)) {
      const hunkIdx = findHunkForPattern(regex, addedText);
      const loc =
        hunkIdx >= 0 ? hunkLocation(hunks[hunkIdx], hunkIdx) : undefined;
      risks.push({
        risk: `Debug output left in code: ${label}`,
        severity: "medium",
        location: loc,
        explanation:
          "Debug logging statements in production code can leak sensitive data " +
          "and clutter output. Replace with proper structured logging or remove.",
      });
      break; // one is enough for this category
    }
    hasOnlyFormatting = false;
    hasOnlyComments = false;
  }

  // ------------------------------------------------------------------
  // LOW severity / classification
  // ------------------------------------------------------------------

  // Check for only-formatting: added lines contain only whitespace changes
  if (addedLines.length > 0) {
    const nonWhitespaceAdded = addedLines.some((line) => {
      const content = line.replace(/^\+/, "");
      return content.trim().length > 0;
    });
    if (!nonWhitespaceAdded) {
      risks.push({
        risk: "Diff contains only whitespace/formatting changes",
        severity: "low",
        explanation:
          "All added lines appear to be whitespace. These are likely formatting-only changes with no functional impact.",
      });
    }
    // Check meaningful non-whitespace, non-comment lines
    const meaningfulAdded = addedLines.some((line) => {
      const content = line.replace(/^\+/, "").trim();
      if (content.length === 0) return false;
      // Skip comment-only lines
      if (
        content.startsWith("//") ||
        content.startsWith("#") ||
        content.startsWith("/*") ||
        content.startsWith("*") ||
        content.startsWith("--")
      ) {
        return false;
      }
      return true;
    });
    if (!meaningfulAdded && addedLines.length > 0) {
      risks.push({
        risk: "Diff contains only comment changes",
        severity: "low",
        explanation:
          "All added non-whitespace lines appear to be comments. These are likely documentation-only changes.",
      });
    }
    hasOnlyFormatting = false; // We know there's content
  }

  // Check for only renames: files changed but content similar
  if (files.length > 1) {
    const oldNames = files.map((f) => f.old.replace(/^[ab]\//, ""));
    const newNames = files.map((f) => f.new.replace(/^[ab]\//, ""));
    const renamed = oldNames.filter((o) => !newNames.includes(o));
    const netNew = newNames.filter((n) => !oldNames.includes(n));
    if (renamed.length === netNew.length && renamed.length > 0) {
      risks.push({
        risk: "Files appear to have been renamed/moved",
        severity: "low",
        explanation:
          `${renamed.length} file(s) renamed. Verify import paths throughout the codebase ` +
          "have been updated accordingly.",
      });
    }
  }

  // Only formatting check
  if (hasOnlyFormatting) {
    risks.push({
      risk: "Diff appears to contain only formatting changes",
      severity: "low",
      explanation:
        "No functional patterns detected. The changes appear to be limited to formatting.",
    });
  }

  return {
    risks,
    hasAuthChanges,
    hasSqlChanges,
    hasNewDeps,
    hasOnlyFormatting,
    hasOnlyComments,
    hasOnlyRenames,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function reviewDiffFallback(
  diff: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): FallbackReviewResult {
  logger.debug("reviewDiffFallback called", {
    diffLength: diff.length,
    maxChars,
  });

  // --- 1. Handle empty diff ---
  if (!diff || diff.trim().length === 0) {
    logger.debug("Empty diff, returning empty result");
    return {
      change_summary: "No changes detected",
      possible_risks: [],
      suggested_source_checks: [],
      suggested_tests: [],
      uncertainties: [
        {
          topic: "Empty diff",
          reason:
            "The provided diff is empty. Either there are no changes or the diff could not be generated.",
        },
      ],
      is_authoritative: false,
    };
  }

  // --- 2. Truncate ---
  let truncated = false;
  let workingDiff = diff;
  if (workingDiff.length > maxChars) {
    workingDiff = workingDiff.slice(0, maxChars);
    truncated = true;
    logger.warn("Diff truncated", {
      originalLength: diff.length,
      maxChars,
    });
  }

  // --- 3. Parse unified diff ---

  // Files: old and new
  const oldFilePattern = /^---\s+(\S+)/gm;
  const newFilePattern = /^\+\+\+\s+(\S+)/gm;

  const oldFiles: string[] = [];
  const newFiles: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = oldFilePattern.exec(workingDiff)) !== null) {
    oldFiles.push(m[1]);
  }
  while ((m = newFilePattern.exec(workingDiff)) !== null) {
    newFiles.push(m[1]);
  }

  const files = oldFiles.map((old, i) => ({
    old,
    new: newFiles[i] ?? "(unknown)",
  }));

  // Detect binary files
  const binaryFiles = files.filter(
    (f) => isBinaryFile(f.new) || isBinaryFile(f.old),
  );
  const hasBinaryChanges = binaryFiles.length > 0;

  // Hunks
  const hunks = parseHunks(workingDiff);

  // Added / removed lines
  const addedLines = workingDiff.match(/^\+[^+]/gm) ?? [];
  const removedLines = workingDiff.match(/^-[^-]/gm) ?? [];

  const additions = addedLines.length;
  const deletions = removedLines.length;
  const totalHunks = hunks.length;
  const fileCount = files.length;

  logger.debug("Diff parsed", {
    fileCount,
    totalHunks,
    additions,
    deletions,
    hasBinaryChanges,
    truncated,
  });

  // --- 4. Detect patterns ---
  const detection = detectPatterns(
    workingDiff,
    addedLines,
    removedLines,
    files,
    hunks,
    truncated,
  );

  // --- 5. Build change_summary ---
  const fileList =
    files.length <= 5
      ? files.map((f) => f.new).join(", ")
      : files
          .slice(0, 5)
          .map((f) => f.new)
          .join(", ") + `, ... (${files.length} total)`;

  const highRisks = detection.risks.filter(
    (r) => r.severity === "critical" || r.severity === "high",
  );
  const medRisks = detection.risks.filter((r) => r.severity === "medium");

  let riskSummary: string;
  if (highRisks.length > 0) {
    riskSummary = `Found ${highRisks.length} high/critical risk pattern(s): ` +
      highRisks.map((r) => r.risk).join("; ") +
      (medRisks.length > 0
        ? `. Also found ${medRisks.length} medium-severity concern(s).`
        : "");
  } else if (medRisks.length > 0) {
    riskSummary = `Found ${medRisks.length} medium-severity concern(s): ` +
      medRisks.map((r) => r.risk).join("; ");
  } else if (detection.risks.length > 0) {
    riskSummary = "Low-severity findings only — mostly cosmetic.";
  } else {
    riskSummary = "No suspicious patterns detected.";
  }

  const binaryNote = hasBinaryChanges
    ? " " + binaryFiles.length + " binary file(s) changed — content not analyzed."
    : "";

  const change_summary =
    `Diff modifies ${fileCount} file(s): ${fileList}. ` +
    `${totalHunks} hunk(s), ${additions} addition(s), ${deletions} deletion(s).` +
    binaryNote +
    ` ${riskSummary}`;

  // --- 6. Build possible_risks ---
  if (hasBinaryChanges) {
    detection.risks.push({
      risk: "Binary file(s) changed — cannot analyze content",
      severity: "medium",
      location: binaryFiles.map((f) => f.new).join(", "),
      explanation:
        "Binary files were modified. The heuristic reviewer cannot inspect their contents. " +
        "Manually verify the source and purpose of these changes.",
    });
  }

  // --- 7. Build suggested_source_checks ---
  const suggested_source_checks: string[] = [];
  for (const f of files) {
    const name = f.new;
    if (binaryFiles.some((bf) => bf.new === name)) {
      suggested_source_checks.push(
        `${name}: Binary file — verify source and rebuild if needed`,
      );
    } else if (
      highRisks.length > 0 &&
      highRisks.some((r) => r.location && r.location.includes(name))
    ) {
      suggested_source_checks.push(
        `${name}: HIGH-RISK — review for security issues (see risks above)`,
      );
    } else {
      suggested_source_checks.push(`${name}: Review for correctness and style`);
    }
  }

  // --- 8. Build suggested_tests ---
  const suggested_tests: string[] = [];

  if (detection.hasAuthChanges) {
    suggested_tests.push(
      "Verify authentication still works for all roles (admin, user, anonymous)",
    );
    suggested_tests.push(
      "Test authorization boundaries: ensure restricted resources are still protected",
    );
  }

  if (detection.hasSqlChanges) {
    suggested_tests.push(
      "Test with SQL injection payloads (e.g., ' OR '1'='1, ; DROP TABLE)",
    );
    suggested_tests.push(
      "Test with benign special characters in query parameters",
    );
  }

  if (detection.hasNewDeps) {
    suggested_tests.push(
      "Run dependency audit (npm audit / cargo audit / go mod verify)",
    );
    suggested_tests.push(
      "Verify the application builds and starts with the new dependency tree",
    );
  }

  // Generic
  suggested_tests.push("Run existing test suite for modified modules");

  if (fileCount > 5) {
    suggested_tests.push(
      "Consider running integration/end-to-end tests — " +
        "many files were modified",
    );
  }

  if (additions > 200) {
    suggested_tests.push(
      "Large diff — consider adding unit tests for new functions",
    );
  }

  // --- 9. Build uncertainties ---
  const uncertainties: FallbackUncertainty[] = [
    {
      topic: "Heuristic scan only",
      reason:
        "Logic and semantic changes are not analyzed — this tool only pattern-matches " +
        "known risky constructs. A thorough review requires human or model-level analysis.",
      suggested_verification:
        "Have a developer review the actual logic and intent behind each change.",
    },
    {
      topic: "No understanding of codebase architecture",
      reason:
        "The reviewer has no knowledge of project conventions, data flow, " +
        "or architectural constraints. A pattern that looks risky may be benign in context.",
      suggested_verification:
        "Review changes against the project's architecture documentation and coding standards.",
    },
    {
      topic: "Pattern-based risk assessment",
      reason:
        "Risk severity is assigned based on pattern matching alone, without semantic context. " +
        "False positives are common, and some real risks may be missed (false negatives).",
      suggested_verification:
        "Treat findings as suggestions, not definitive security analysis. " +
        "Use a dedicated security scanner for production-critical changes.",
    },
  ];

  if (truncated) {
    uncertainties.push({
      topic: "Diff was truncated",
      reason:
        `The diff exceeded the ${maxChars.toLocaleString()} character limit and was truncated. ` +
        "Analysis only covers the first portion of the changes.",
      suggested_verification:
        "If the diff is large, consider reviewing it in smaller chunks by file or directory.",
    });
  }

  if (hasBinaryChanges) {
    uncertainties.push({
      topic: "Binary file changes not analyzed",
      reason:
        "Binary file contents cannot be inspected by this heuristic reviewer. " +
        "Only the fact that they changed is noted.",
      suggested_verification:
        "Manually verify binary assets (images, fonts, compiled binaries) for correctness and legitimacy.",
    });
  }

  const result: FallbackReviewResult = {
    change_summary,
    possible_risks: detection.risks,
    suggested_source_checks,
    suggested_tests,
    uncertainties,
    is_authoritative: false,
  };

  logger.debug("reviewDiffFallback result", {
    riskCount: result.possible_risks.length,
    checksCount: result.suggested_source_checks.length,
    testsCount: result.suggested_tests.length,
    uncertaintyCount: result.uncertainties.length,
  });

  return result;
}
