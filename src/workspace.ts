/**
 * Workspace path resolution with hardening against path traversal and
 * symlink escapes on macOS.
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Walk up the directory tree from `filePath` until we find an ancestor that
 * exists on disk, resolve *its* real path (symlinks), then
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
 * 1. Reject absolute paths.
 * 2. Reject `..` traversal that would escape the workspace root.
 * 3. Resolve symlinks via `fs.realpathSync` on both the
 *    workspace root and the resolved target path (or nearest existing
 *    ancestor when the target does not exist yet).
 * 4. Verify that the real target path is the workspace root itself, or a
 *    descendant that starts with `workspaceRoot + path.sep`.
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

  // ---- Step 1: reject absolute paths --------------------------------
  if (path.isAbsolute(userPath)) {
    throw new Error(`Absolute paths are not allowed: ${userPath}`);
  }

  // ---- Resolve the user path against the workspace root -------------
  // path.resolve handles ".." normalization (Step 2) and produces an
  // absolute path rooted at workspaceRoot.
  const normalized = path.normalize(userPath);
  const resolvedTarget = path.resolve(workspaceRoot, normalized);

  logger.debug("resolveSafePath: resolving", {
    workspaceRoot,
    userPath,
    normalizedPath: normalized,
    resolvedTarget,
  });

  // ---- Resolve workspace root real path (Step 3) --------------------
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

  // ---- Resolve target real path (Step 3) ----------------------------
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
