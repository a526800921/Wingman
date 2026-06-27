/**
 * A control fixture: TypeScript file with standard patterns.
 * Used to verify TS fallback behavior is not regressed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  key: string;
  value: T;
  expiresAt: number;
  createdAt: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

type Serializer<T> = (value: T) => string;
type Deserializer<T> = (raw: string) => T;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

enum CacheErrorCode {
  KeyNotFound = "KEY_NOT_FOUND",
  Expired = "EXPIRED",
  SerializationFailed = "SERIALIZATION_FAILED",
  StorageFull = "STORAGE_FULL",
}

class CacheError extends Error {
  constructor(
    public readonly code: CacheErrorCode,
    message: string,
    public readonly key?: string,
  ) {
    super(message);
    this.name = "CacheError";
  }
}

// ---------------------------------------------------------------------------
// Main cache class
// ---------------------------------------------------------------------------

export class FileSystemCache<T> {
  private cacheDir: string;
  private maxEntries: number;
  private defaultTTL: number;
  private stats: CacheStats;
  private serializer: Serializer<T>;
  private deserializer: Deserializer<T>;

  constructor(
    cacheDir: string,
    options: {
      maxEntries?: number;
      defaultTTL?: number;
      serializer?: Serializer<T>;
      deserializer?: Deserializer<T>;
    } = {},
  ) {
    this.cacheDir = cacheDir;
    this.maxEntries = options.maxEntries ?? 1000;
    this.defaultTTL = options.defaultTTL ?? 3600_000;
    this.serializer = options.serializer ?? ((v: T) => JSON.stringify(v));
    this.deserializer = options.deserializer ?? ((r: string) => JSON.parse(r) as T);
    this.stats = { hits: 0, misses: 0, size: 0, evictions: 0 };
  }

  // ---- public API ----

  async get(key: string): Promise<T | undefined> {
    const entry = await this.readEntry(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.stats.misses++;
      await this.delete(key);
      return undefined;
    }

    this.stats.hits++;
    return entry.value;
  }

  async set(key: string, value: T, ttl?: number): Promise<void> {
    if (this.stats.size >= this.maxEntries) {
      await this.evictOldest();
    }

    const entry: CacheEntry<T> = {
      key,
      value,
      expiresAt: Date.now() + (ttl ?? this.defaultTTL),
      createdAt: Date.now(),
    };

    await this.writeEntry(entry);
    this.stats.size++;
  }

  async delete(key: string): Promise<void> {
    const filePath = this.entryPath(key);
    try {
      writeFileSync(filePath, "", { flag: "w" });
      this.stats.size = Math.max(0, this.stats.size - 1);
    } catch {
      // File may not exist — that's fine
    }
  }

  getStats(): Readonly<CacheStats> {
    return { ...this.stats };
  }

  async clear(): Promise<void> {
    this.stats = { hits: 0, misses: 0, size: 0, evictions: 0 };
  }

  // ---- private ----

  private entryPath(key: string): string {
    const safeKey = Buffer.from(key).toString("hex").slice(0, 64);
    return join(this.cacheDir, safeKey);
  }

  private async readEntry(key: string): Promise<CacheEntry<T> | null> {
    try {
      const raw = readFileSync(this.entryPath(key), "utf-8");
      return JSON.parse(raw) as CacheEntry<T>;
    } catch {
      return null;
    }
  }

  private async writeEntry(entry: CacheEntry<T>): Promise<void> {
    const raw = JSON.stringify(entry);
    writeFileSync(this.entryPath(entry.key), raw, "utf-8");
  }

  private async evictOldest(): Promise<void> {
    this.stats.evictions++;
    this.stats.size = Math.max(0, this.stats.size - 1);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFileCache<T>(
  namespace: string,
  options?: { maxEntries?: number; defaultTTL?: number },
): FileSystemCache<T> {
  const cacheDir = resolve(process.cwd(), ".cache", namespace);
  return new FileSystemCache<T>(cacheDir, options);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ENTRIES = 1000;
export const DEFAULT_TTL_MS = 3_600_000; // 1 hour
export const MIN_TTL_MS = 1_000; // 1 second minimum

// ---------------------------------------------------------------------------
// Re-export commonly used error code for consumers
// ---------------------------------------------------------------------------

export { CacheErrorCode, CacheError };
