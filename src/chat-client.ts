/**
 * Chat client — sends chat completion requests to the configured model endpoint.
 *
 * Implements HTTP 安全策略 from PLAN.md:
 *   - HTTPS enforcement (with opt-in localhost HTTP)
 *   - Host allowlist
 *   - SSRF prevention (private / link-local / loopback / cloud metadata)
 *   - Timeout via AbortController
 *   - Retry on transient errors (network errors, 5xx) with exponential backoff
 *   - API key passed as Bearer token, never logged
 */

import { lookup } from "node:dns/promises";
import { URL } from "node:url";
import { logger } from "./logger.js";
import type { AppConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ChatClientError extends Error {
  public readonly code: "timeout" | "http" | "parse" | "config" | "ssrf";

  constructor(
    message: string,
    code: "timeout" | "http" | "parse" | "config" | "ssrf",
  ) {
    super(message);
    this.name = "ChatClientError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// SSRF / IP-range helpers
// ---------------------------------------------------------------------------

/** CIDR ranges that are never allowed as destinations. */
interface CidrBlock {
  readonly prefix: number; // network prefix as 32-bit unsigned integer
  readonly mask: number; // subnet mask as 32-bit unsigned integer
  readonly label: string;
}

const BLOCKED_IPV4_RANGES: readonly CidrBlock[] = [
  { prefix: ipv4ToInt([10, 0, 0, 0]), mask: cidrMask(8), label: "10.0.0.0/8 (private)" },
  { prefix: ipv4ToInt([172, 16, 0, 0]), mask: cidrMask(12), label: "172.16.0.0/12 (private)" },
  { prefix: ipv4ToInt([192, 168, 0, 0]), mask: cidrMask(16), label: "192.168.0.0/16 (private)" },
  { prefix: ipv4ToInt([169, 254, 0, 0]), mask: cidrMask(16), label: "169.254.0.0/16 (link-local)" },
  { prefix: ipv4ToInt([127, 0, 0, 0]), mask: cidrMask(8), label: "127.0.0.0/8 (loopback)" },
];

const CLOUD_METADATA_IP = ipv4ToInt([169, 254, 169, 254]);

/** Special hostnames that resolve to loopback. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function ipv4ToInt(octets: readonly [number, number, number, number]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function cidrMask(bits: number): number {
  return bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
}

/** True when `addr` (uint32) falls inside the given CIDR block. */
function ipInBlock(addr: number, block: CidrBlock): boolean {
  return (addr & block.mask) === block.prefix;
}

/**
 * Parse an IPv4 dotted-decimal string into a uint32, or `null` if the string
 * is not a valid IPv4 address.
 */
function parseIPv4(raw: string): number | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return ipv4ToInt([octets[0], octets[1], octets[2], octets[3]]);
}

// ---------------------------------------------------------------------------
// SSRF check
// ---------------------------------------------------------------------------

/**
 * Resolve `hostname` via DNS and verify it does not point to a blocked IP.
 * Throws `ChatClientError` (code "ssrf") when the destination is forbidden.
 */
async function assertSafeHost(
  hostname: string,
  allowInsecureLocalHttp: boolean,
): Promise<void> {
  // Quick check: is the hostname itself a known loopback label?
  const normalized = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(normalized)) {
    if (!allowInsecureLocalHttp) {
      throw new ChatClientError(
        `SSRF blocked: loopback hostname "${hostname}" is not allowed (set allowInsecureLocalHttp=true for local dev)`,
        "ssrf",
      );
    }
    // Allowed — skip further checks for local loopback
    return;
  }

  // Quick check: is the hostname a raw IPv4 that falls into blocked ranges?
  const rawIPv4 = parseIPv4(normalized);
  if (rawIPv4 !== null) {
    assertSafeIPv4(rawIPv4, hostname, allowInsecureLocalHttp);
    return;
  }

  // Resolve hostname → IP via DNS for deeper SSRF check.
  let resolvedAddr: string;
  try {
    const result = await lookup(hostname, { family: 4, all: false });
    resolvedAddr = result.address;
  } catch {
    // DNS resolution failure — let the fetch call fail naturally later.
    return;
  }

  const resolvedNum = parseIPv4(resolvedAddr);
  if (resolvedNum !== null) {
    assertSafeIPv4(resolvedNum, resolvedAddr, allowInsecureLocalHttp);
  }

  // --- IPv6 check ---
  try {
    const result6 = await lookup(hostname, { family: 6, all: false });
    assertSafeIPv6(result6.address, allowInsecureLocalHttp);
  } catch {
    // No IPv6 address — ok, IPv4 check above is sufficient
  }
}

/**
 * Blocked IPv6 address prefixes.
 * - Loopback: ::1/128
 * - Link-local: fe80::/10
 * - Unique local (ULA): fc00::/7
 * - IPv4-mapped: ::ffff:0:0/96 (covers ::ffff:10.x.x.x etc.)
 * - Cloud metadata (IPv6): fd00::/8 (commonly used for link-local metadata services)
 */
const BLOCKED_IPV6_RANGES: Array<{
  label: string;
  prefix: Uint8Array;
  prefixLen: number;
  isLoopback: boolean;
}> = [
  {
    label: "loopback (::1)",
    prefix: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
    prefixLen: 128,
    isLoopback: true,
  },
  {
    label: "link-local (fe80::/10)",
    prefix: new Uint8Array([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    prefixLen: 10,
    isLoopback: false,
  },
  {
    label: "ULA (fc00::/7)",
    prefix: new Uint8Array([0xfc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    prefixLen: 7,
    isLoopback: false,
  },
  {
    label: "IPv4-mapped (::ffff:0:0/96)",
    prefix: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0]),
    prefixLen: 96,
    isLoopback: false,
  },
  {
    label: "cloud-meta / documentation / private (fd00::/8)",
    prefix: new Uint8Array([0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    prefixLen: 8,
    isLoopback: false,
  },
];

/** Simple IPv6 address string → 16-byte array, or null on parse failure. */
function parseIPv6(raw: string): Uint8Array | null {
  // Node's `net` module can do this more robustly — use a light parser here
  // to avoid extra imports.  Accept the standard colon-hex form and the
  // IPv4-mapped ::ffff:a.b.c.d form.
  try {
    // Use URL parse trick: http://[::1]/ → hostname
    const u = new URL(`http://[${raw}]/`);
    const addr = u.hostname;
    // net.isIPv6 validates and normalizes; but to avoid node:net, we rely
    // on the URL parser having accepted it as a bracketed host. If the URL
    // parse succeeded, the string is a valid IPv6 literal. Convert to bytes.
    const parts = addr.split(":");
    const bytes = new Uint8Array(16);
    let byteIdx = 0;
    let gapIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "") {
        // :: gap
        if (gapIdx >= 0) {
          // multiple gaps — invalid, but URL parser wouldn't produce this
          return null;
        }
        gapIdx = byteIdx;
        continue;
      }
      const val = parseInt(parts[i], 16);
      if (isNaN(val) || val < 0 || val > 0xffff) return null;
      bytes[byteIdx++] = (val >> 8) & 0xff;
      bytes[byteIdx++] = val & 0xff;
    }
    if (gapIdx >= 0) {
      // Shift bytes to fill the gap
      const filled = byteIdx;
      const shift = 16 - filled;
      for (let i = filled - 1; i >= gapIdx; i--) {
        bytes[i + shift] = bytes[i];
      }
      for (let i = gapIdx; i < gapIdx + shift; i++) {
        bytes[i] = 0;
      }
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Check an IPv6 address string against blocked ranges. */
function assertSafeIPv6(
  addr: string,
  allowInsecureLocalHttp: boolean,
): void {
  const bytes = parseIPv6(addr);
  if (!bytes) return; // unable to parse — skip (fetch will fail if truly invalid)

  for (const block of BLOCKED_IPV6_RANGES) {
    if (ipv6InBlock(bytes, block)) {
      if (block.isLoopback && allowInsecureLocalHttp) {
        return; // explicitly allowed for local dev
      }
      throw new ChatClientError(
        `SSRF blocked: destination resolves to ${block.label} (${addr})`,
        "ssrf",
      );
    }
  }
}

/** True when `bytes` (16-byte IPv6) falls inside the given prefix block. */
function ipv6InBlock(bytes: Uint8Array, block: typeof BLOCKED_IPV6_RANGES[number]): boolean {
  const fullBytes = block.prefixLen >> 3;
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== block.prefix[i]) return false;
  }
  const remainingBits = block.prefixLen & 7;
  if (remainingBits > 0) {
    const mask = 0xff << (8 - remainingBits);
    if ((bytes[fullBytes] & mask) !== (block.prefix[fullBytes] & mask)) return false;
  }
  return true;
}

/**
 * Check a resolved IPv4 address (as uint32) against blocked ranges.
 * Allows loopback only when `allowInsecureLocalHttp` is true.
 */
function assertSafeIPv4(
  addr: number,
  displayAddr: string,
  allowInsecureLocalHttp: boolean,
): void {
  // Cloud metadata endpoint (exact match)
  if (addr === CLOUD_METADATA_IP) {
    throw new ChatClientError(
      `SSRF blocked: destination resolves to cloud metadata IP 169.254.169.254 (${displayAddr})`,
      "ssrf",
    );
  }

  for (const block of BLOCKED_IPV4_RANGES) {
    if (ipInBlock(addr, block)) {
      // Loopback range — allowed only with insecure local flag
      const isLoopback = block.label.includes("loopback");
      if (isLoopback && allowInsecureLocalHttp) {
        return;
      }
      throw new ChatClientError(
        `SSRF blocked: destination resolves to ${block.label} (${displayAddr})`,
        "ssrf",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// URL / scheme validation
// ---------------------------------------------------------------------------

/**
 * Validate the URL scheme and host.  Returns a sanitised URL string suitable
 * for use with `fetch`.
 */
async function validateUrl(
  rawUrl: string,
  allowedHosts: readonly string[],
  allowInsecureLocalHttp: boolean,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ChatClientError(`Invalid model URL: "${rawUrl}"`, "config");
  }

  // 1. Scheme check
  if (parsed.protocol !== "https:") {
    const isHttpLocal =
      parsed.protocol === "http:" &&
      allowInsecureLocalHttp &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1" ||
        parsed.hostname === "[::1]");
    if (!isHttpLocal) {
      throw new ChatClientError(
        `Model URL must use HTTPS (got "${parsed.protocol}"). ` +
          `Set allowInsecureLocalHttp=true only for localhost HTTP dev servers.`,
        "config",
      );
    }
  }

  // 2. Host allowlist
  if (allowedHosts.length > 0 && !allowedHosts.includes(parsed.hostname)) {
    throw new ChatClientError(
      `Host "${parsed.hostname}" is not in the allowed hosts list: [${allowedHosts.join(", ")}]`,
      "config",
    );
  }

  // 3. SSRF check (DNS-resolve hostname and verify IP)
  await assertSafeHost(parsed.hostname, allowInsecureLocalHttp);

  return parsed.href;
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine whether an error is transient and worth retrying.
 *
 * Retryable:
 *   - TypeError / network errors (fetch throws TypeError on network failure)
 *   - AbortError that was NOT caused by our timeout
 *   - 5xx responses (502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout)
 *
 * NOT retryable:
 *   - ChatClientError (our own structured errors)
 *   - 4xx responses
 *   - Timeout AbortError (handled before reaching here)
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof ChatClientError) return false;

  // Network-level errors
  if (err instanceof TypeError) return true;

  // AbortError not caused by timeout (e.g. connection reset)
  if (err instanceof DOMException && err.name === "AbortError") return true;

  return false;
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

interface ChatResponseMessage {
  role: string;
  content: string;
}

interface ChatResponseChoice {
  index: number;
  message: ChatResponseMessage;
  finish_reason?: string;
}

interface ChatResponseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface ChatResponseBody {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: ChatResponseChoice[];
  usage?: ChatResponseUsage;
}

// ---------------------------------------------------------------------------
// ChatClient
// ---------------------------------------------------------------------------

const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 2000]; // exponential: 2^0 * 1000, 2^1 * 1000

export class ChatClient {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /** True when an API key is configured (model mode, not fallback). */
  isAvailable(): boolean {
    return this.config.modelApiKey.length > 0;
  }

  /**
   * Send a chat completion request and return the model's text response.
   *
   * Security guarantees:
   *   - HTTPS enforced (unless localhost opt-in)
   *   - Host allowlist checked
   *   - SSRF blocked (private, link-local, loopback, cloud metadata IPs)
   *   - Timeout via AbortController
   *   - Retry on transient errors with exponential backoff
   *   - API key never logged
   */
  async chat(systemPrompt: string, userMessage: string): Promise<string> {
    // -------- build URL --------
    const base = this.config.modelBaseUrl.replace(/\/+$/, "");
    const rawUrl = `${base}/chat/completions`;

    const url = await validateUrl(
      rawUrl,
      this.config.modelAllowedHosts,
      this.config.allowInsecureLocalHttp,
    );

    // -------- build body --------
    const body = JSON.stringify({
      model: this.config.modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 4096,
      stream: false,
    });

    // -------- build headers (API key in Authorization — never logged) --------
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.modelApiKey}`,
    };

    // -------- request with retry loop --------
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.performRequest(url, headers, body);
      } catch (err: unknown) {
        lastError = err;

        // Timeout errors are NOT retried
        if (err instanceof ChatClientError && err.code === "timeout") {
          throw err;
        }

        // HTTP responses that are retryable (5xx)
        if (err instanceof ChatClientError && err.code === "http") {
          // Extract status from error message for retry check
          const statusMatch = err.message.match(/HTTP (\d{3})/);
          const status = statusMatch ? Number(statusMatch[1]) : 0;
          if (isRetryableStatus(status) && attempt < MAX_RETRIES) {
            const delay = RETRY_DELAYS_MS[attempt];
            logger.warn(
              `chat request retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (HTTP ${status})`,
            );
            await sleep(delay);
            continue;
          }
          throw err;
        }

        // Transient network errors
        if (isRetryable(err) && attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS_MS[attempt];
          logger.warn(
            `chat request retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (${describeError(err)})`,
          );
          await sleep(delay);
          continue;
        }

        throw err;
      }
    }

    // Should be unreachable, but satisfy TypeScript
    throw lastError;
  }

  // ---- internal: single request attempt ----

  private async performRequest(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<string> {
    // --- setup timeout ---
    let timedOut = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.modelTimeoutMs);

    logger.debug("chat request started", { model: this.config.modelName });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      // Timeout
      if (timedOut && err instanceof DOMException && err.name === "AbortError") {
        logger.error("chat request timed out", {
          model: this.config.modelName,
          timeoutMs: this.config.modelTimeoutMs,
        });
        throw new ChatClientError(
          `Request timed out after ${this.config.modelTimeoutMs}ms`,
          "timeout",
        );
      }

      // Other network errors (TypeError, connection reset AbortError, etc.)
      logger.error("chat request network error", {
        model: this.config.modelName,
        errorType: describeError(err),
      });
      throw err;
    }

    clearTimeout(timeoutId);

    // --- handle non-ok responses ---
    if (!response.ok) {
      const status = response.status;
      // Read a small prefix of the body for diagnostics — never log the full body
      let bodyPreview = "";
      try {
        const text = await response.text();
        bodyPreview = text.slice(0, 200);
      } catch {
        bodyPreview = "(could not read response body)";
      }

      logger.error("chat request failed", {
        model: this.config.modelName,
        status,
        statusText: response.statusText,
        // body preview is logged separately via error level
      });
      if (bodyPreview) {
        logger.debug("response body preview", { preview: bodyPreview });
      }

      throw new ChatClientError(
        `HTTP ${status} ${response.statusText}: ${bodyPreview}`,
        "http",
      );
    }

    // --- parse successful response ---
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      logger.error("chat response parse error", { model: this.config.modelName });
      throw new ChatClientError(
        "Failed to parse JSON response from model server",
        "parse",
      );
    }

    if (typeof data !== "object" || data === null) {
      throw new ChatClientError(
        "Unexpected response type from model server",
        "parse",
      );
    }

    const bodyData = data as ChatResponseBody;

    // Extract content
    const choices = bodyData.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ChatClientError(
        "Model response has no choices array",
        "parse",
      );
    }

    const message = choices[0]?.message;
    if (!message || typeof message.content !== "string") {
      throw new ChatClientError(
        "Model response missing choices[0].message.content",
        "parse",
      );
    }

    // Log completion with token usage if available
    const usage = bodyData.usage;
    logger.info("chat request completed", {
      model: bodyData.model ?? this.config.modelName,
      usage: usage
        ? {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
          }
        : undefined,
    });

    return message.content;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  if (err instanceof Error) return err.constructor.name;
  return typeof err === "string" ? err : String(err);
}
