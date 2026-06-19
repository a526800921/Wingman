/**
 * Workspace path resolution with hardening against path traversal and
 * platform-specific attacks (NTFS junctions, ADS, DOS device names).
 *
 * All path resolution results are verified to be within the workspace root.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file read size (characters), can be overridden by callers */
export const DEFAULT_MAX_READ_CHARS = 100_000;

/** Reserved DOS device names (case-insensitive, any file extension) */
const DOS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

// Matches a drive-relative segment: letter + colon + NOT a separator
// e.g. "C:foo" but NOT "C:\" or "C:/"
const DRIVE_RELATIVE_RE = /^[a-zA-Z]:[^\\/]/;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a filename (without any directory prefix) is a reserved
 * DOS device name.  The check is case-insensitive and strips any file
 * extension before comparing.
 *
 * @example
 * isDosDeviceName("CON")         // true
 * isDosDeviceName("con.txt")     // true
 * isDosDeviceName("LPT9.dat")    // true
 * isDosDeviceName("normal.ts")   // false
 */
export function isDosDeviceName(name: string): boolean {
  const ext = path.extname(name);
  const base = ext.length > 0 ? name.slice(0, -ext.length) : name;
  return DOS_DEVICE_NAMES.has(base.toUpperCase());
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Walk up the directory tree from `filePath` until we find an ancestor that
 * exists on disk, resolve *its* real path (symlinks / junctions), then
 * re-attach the non-existent suffix.
 *
 * This prevents symlink escapes when the target file does not exist yet
 * (e.g. creating a new file inside a symlink that points outside the
 * workspace).
 */
function resolveNearestExisting(filePath: string): string {
  let ancestor = path.dirname(filePath);

  while (true) {
    try {
      const realAncestor = fs.realpathSync(ancestor, { encoding: "utf-8" });
      const relative = path.relative(ancestor, filePath);
      return path.join(realAncestor, relative);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        const parent = path.dirname(ancestor);
        // Reached the filesystem root — nothing exists along the path
        if (parent === ancestor) {
          return path.resolve(filePath);
        }
        ancestor = parent;
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied relative path against a trusted workspace root.
 *
 * Hardening steps (in order):
 * 1. Reject absolute paths (Windows `C:\...` and Unix `/...`).
 * 2. Reject UNC paths (`\\server\share\...` and `//server/share/...`).
 * 3. Reject drive-relative paths (`C:foo` — drive letter without separator).
 * 4. Reject `..` traversal that would escape the workspace root.
 * 5. Resolve symlinks / NTFS junctions via `fs.realpathSync` on both the
 *    workspace root and the resolved target path (or nearest existing
 *    ancestor when the target does not exist yet).
 * 6. Verify that the real target path is the workspace root itself, or a
 *    descendant that starts with `workspaceRoot + path.sep`.
 * 7. Reject NTFS alternate data streams (`file.txt::$DATA` or
 *    `file.txt:streamname`).
 * 8. Reject reserved DOS device names (CON, PRN, AUX, NUL, COM1–COM9,
 *    LPT1–LPT9) in any path component, regardless of file extension.
 *
 * @param workspaceRoot  Trusted workspace root directory.
 * @param userPath       User-supplied relative path to resolve.
 * @returns              Verified absolute real path inside the workspace.
 * @throws               Error with a descriptive message on any violation.
 */
export function resolveSafePath(
  workspaceRoot: string,
  userPath: string,
): string {
  // ---- Step 0: reject empty paths -----------------------------------
  if (!userPath || userPath.trim() === "") {
    throw new Error(`Empty or whitespace-only paths are not allowed`);
  }

  // ---- Step 1: reject UNC paths (before isAbsolute — UNC paths are
  //              considered absolute on Windows) -----------------------
  if (userPath.startsWith("\\\\") || userPath.startsWith("//")) {
    throw new Error(`UNC paths are not allowed: ${userPath}`);
  }

  // ---- Step 2: reject absolute paths --------------------------------
  if (path.isAbsolute(userPath)) {
    throw new Error(`Absolute paths are not allowed: ${userPath}`);
  }

  // ---- Step 3: reject drive-relative paths at the start -------------
  // e.g. "C:foo" — a drive letter followed by colon but no separator
  if (DRIVE_RELATIVE_RE.test(userPath)) {
    throw new Error(`Drive-relative paths are not allowed: ${userPath}`);
  }

  // ---- Step 7 & 8: validate every path component --------------------
  // Split on both Windows and Unix separators to catch cross-platform
  // injection attempts.
  const components = userPath.split(/[\\/]/);

  for (const comp of components) {
    // Skip empty segments (from leading / trailing / doubled separators)
    // and single-dot segments (current directory).
    if (comp === "" || comp === ".") {
      continue;
    }

    // Step 3 (continued): drive-relative inside a subdirectory
    // e.g. "subdir/C:foo"
    if (DRIVE_RELATIVE_RE.test(comp)) {
      throw new Error(`Drive-relative paths are not allowed: ${userPath}`);
    }

    // Step 7: NTFS alternate data streams
    // ADS uses "::" as the stream separator, e.g. "file.txt::$DATA"
    // A single ":" (e.g. "file.txt:streamname") is also an ADS marker.
    // At this point any colon in a component is suspicious because
    // absolute paths and drive-relative paths have already been rejected.
    if (comp.includes(":")) {
      throw new Error(
        `NTFS alternate data streams are not allowed: ${userPath}`,
      );
    }

    // Step 8: reserved DOS device names
    if (isDosDeviceName(comp)) {
      throw new Error(`DOS device names are not allowed: ${comp}`);
    }
  }

  // ---- Resolve the user path against the workspace root -------------
  // path.resolve handles ".." normalization (Step 4) and produces an
  // absolute path rooted at workspaceRoot.
  const normalized = path.normalize(userPath);
  const resolvedTarget = path.resolve(workspaceRoot, normalized);

  logger.debug("resolveSafePath: resolving", {
    workspaceRoot,
    userPath,
    normalizedPath: normalized,
    resolvedTarget,
  });

  // ---- Resolve workspace root real path (Step 5) --------------------
  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = fs.realpathSync(workspaceRoot, { encoding: "utf-8" });
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      // Workspace root does not exist — use the resolved path as-is.
      // The caller is responsible for ensuring the workspace exists.
      realWorkspaceRoot = path.resolve(workspaceRoot);
      logger.debug(
        `Workspace root does not exist, falling back to resolved path: ${realWorkspaceRoot}`,
      );
    } else {
      throw err;
    }
  }

  // ---- Resolve target real path (Step 5) ----------------------------
  // The target file may not exist yet (e.g. validating before creation).
  // In that case walk up to the nearest existing ancestor, resolve its
  // real path, and re-attach the non-existent suffix.
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(resolvedTarget, { encoding: "utf-8" });
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      // Target does not exist — resolve via nearest existing ancestor
      // to catch symlink escapes in parent directories.
      realTarget = resolveNearestExisting(resolvedTarget);
      logger.debug(
        `Target does not exist yet, using nearest-ancestor resolution: ${realTarget}`,
      );
    } else {
      throw err;
    }
  }

  logger.debug("resolveSafePath: real paths", {
    realWorkspaceRoot,
    realTarget,
  });

  // ---- Step 4 & 6: verify target is within workspace root -----------
  // After realpath resolution (which resolves symlinks and junctions),
  // the target must either equal the workspace root or be a descendant
  // (start with workspaceRoot + platform separator).
  if (
    realTarget !== realWorkspaceRoot &&
    !realTarget.startsWith(realWorkspaceRoot + path.sep)
  ) {
    throw new Error(
      `Path traversal detected: "${userPath}" resolves to "${realTarget}" ` +
        `which is outside workspace root "${realWorkspaceRoot}"`,
    );
  }

  logger.debug(
    `resolveSafePath: resolved "${userPath}" -> "${realTarget}"`,
  );

  return realTarget;
}
