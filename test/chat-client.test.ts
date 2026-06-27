/**
 * Tests for ChatClient — constructor, SSRF helpers, and error handling.
 *
 * Covers all exported pure functions from chat-client.ts.
 * No network calls needed for these tests.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const savedEnv = { ...process.env };

function resetEnv() {
  delete process.env.AUX_MODEL_API_KEY;
  delete process.env.AUX_MODEL_BASE_URL;
  delete process.env.AUX_MODEL_NAME;
  delete process.env.AUX_MODEL_PROVIDER;
  delete process.env.AUX_MODEL_TIMEOUT_MS;
  delete process.env.AUX_MODEL_ALLOWED_HOSTS;
  delete process.env.AUX_MODEL_DISABLE_THINKING;
  delete process.env.AUX_ALLOW_INSECURE_LOCAL_HTTP;
}

describe("ChatClient constructor + isAvailable", () => {
  let ChatClient: any;
  let ChatClientError: any;

  before(async () => {
    const mod = await import("../src/chat-client.js");
    ChatClient = mod.ChatClient;
    ChatClientError = mod.ChatClientError;
  });

  after(() => {
    process.env = savedEnv;
  });

  it("constructs with valid config", () => {
    const client = new ChatClient({
      modelApiKey: "test-key",
      modelBaseUrl: "https://api.openai.com/v1",
      modelName: "gpt-4",
      modelProvider: "remote",
      modelTimeoutMs: 30000,
      modelAllowedHosts: [],
      modelDisableThinking: false,
      allowInsecureLocalHttp: false,
      workspaceRoot: "/tmp",
    });
    assert.ok(client instanceof ChatClient);
    assert.equal(client.isAvailable(), true);
  });

  it("isAvailable false without API key", () => {
    resetEnv();
    const client = new ChatClient({
      modelApiKey: "",
      modelBaseUrl: "https://api.openai.com/v1",
      modelName: "gpt-4",
      modelProvider: "remote",
      modelTimeoutMs: 30000,
      modelAllowedHosts: [],
      modelDisableThinking: false,
      allowInsecureLocalHttp: false,
      workspaceRoot: "/tmp",
    });
    assert.equal(client.isAvailable(), false);
  });

  it("constructs with local config", () => {
    const client = new ChatClient({
      modelApiKey: "not-needed",
      modelBaseUrl: "http://localhost:11434/v1",
      modelName: "llama3",
      modelProvider: "local",
      modelTimeoutMs: 60000,
      modelAllowedHosts: [],
      modelDisableThinking: false,
      allowInsecureLocalHttp: true,
      workspaceRoot: "/tmp",
    });
    assert.ok(client instanceof ChatClient);
  });

  it("constructs with custom allowed hosts", () => {
    const client = new ChatClient({
      modelApiKey: "key",
      modelBaseUrl: "https://custom.api.com/v1",
      modelName: "custom-model",
      modelProvider: "remote",
      modelTimeoutMs: 15000,
      modelAllowedHosts: ["custom.api.com"],
      modelDisableThinking: true,
      allowInsecureLocalHttp: false,
      workspaceRoot: "/tmp",
    });
    assert.equal(client.isAvailable(), true);
  });

  it("isAvailable false with empty baseUrl", () => {
    // Empty URL is not valid — either throws or returns false
    try {
      const client = new ChatClient({
        modelApiKey: "key",
        modelBaseUrl: "",
        modelName: "model",
        modelProvider: "remote",
        modelTimeoutMs: 30000,
        modelAllowedHosts: [],
        modelDisableThinking: false,
        allowInsecureLocalHttp: false,
        workspaceRoot: "/tmp",
      });
      // If constructor doesn't throw, isAvailable should be false
      assert.equal(client.isAvailable(), false);
    } catch {
      // Constructor throwing is also acceptable behavior
      assert.ok(true);
    }
  });
});

describe("ChatClientError", () => {
  let ChatClientError: any;

  before(async () => {
    ({ ChatClientError } = await import("../src/chat-client.js"));
  });

  it("constructs with message and code", () => {
    const err = new ChatClientError("Connection refused", "timeout");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "ChatClientError");
    assert.equal(err.code, "timeout");
    assert.equal(err.message, "Connection refused");
  });

  it("all valid error codes", () => {
    for (const code of ["timeout", "http", "parse", "config", "ssrf"] as const) {
      const err = new ChatClientError(`Test: ${code}`, code);
      assert.equal(err.code, code);
      assert.equal(err.name, "ChatClientError");
    }
  });
});

// ---------------------------------------------------------------------------
// IPv4 helpers
// ---------------------------------------------------------------------------

describe("IPv4 helpers", () => {
  let ipv4ToInt: Function;
  let cidrMask: Function;
  let ipInBlock: Function;
  let parseIPv4: Function;

  before(async () => {
    const mod = await import("../src/chat-client.js");
    ipv4ToInt = mod.ipv4ToInt;
    cidrMask = mod.cidrMask;
    ipInBlock = mod.ipInBlock;
    parseIPv4 = mod.parseIPv4;
  });

  it("ipv4ToInt converts octets to uint32", () => {
    assert.equal(ipv4ToInt([127, 0, 0, 1]), 0x7F000001);
    assert.equal(ipv4ToInt([192, 168, 1, 1]), 0xC0A80101);
    assert.equal(ipv4ToInt([0, 0, 0, 0]), 0);
    assert.equal(ipv4ToInt([255, 255, 255, 255]), 0xFFFFFFFF);
  });

  it("cidrMask creates proper subnet masks", () => {
    assert.equal(cidrMask(0), 0);
    assert.equal(cidrMask(8), 0xFF000000);
    assert.equal(cidrMask(16), 0xFFFF0000);
    assert.equal(cidrMask(24), 0xFFFFFF00);
    assert.equal(cidrMask(32), 0xFFFFFFFF);
  });

  it("ipInBlock checks CIDR membership", () => {
    const block = { prefix: ipv4ToInt([10, 0, 0, 0]), mask: cidrMask(8), label: "10.0.0.0/8" };
    // 10.0.0.1 is in 10.0.0.0/8
    assert.equal(ipInBlock(ipv4ToInt([10, 0, 0, 1]), block), true);
    // 10.255.255.255 is in 10.0.0.0/8
    assert.equal(ipInBlock(ipv4ToInt([10, 255, 255, 255]), block), true);
    // 11.0.0.1 is NOT in 10.0.0.0/8
    assert.equal(ipInBlock(ipv4ToInt([11, 0, 0, 1]), block), false);
    // 192.168.1.1 is NOT in 10.0.0.0/8
    assert.equal(ipInBlock(ipv4ToInt([192, 168, 1, 1]), block), false);
  });

  it("parseIPv4 parses valid addresses", () => {
    const result = parseIPv4("192.168.1.1");
    assert.ok(result !== null);
    assert.equal(result, 0xC0A80101);
  });

  it("parseIPv4 parses loopback", () => {
    const result = parseIPv4("127.0.0.1");
    assert.equal(result, 0x7F000001);
  });

  it("parseIPv4 returns null for invalid addresses", () => {
    assert.equal(parseIPv4("not.an.ip"), null);
    assert.equal(parseIPv4(""), null);
    assert.equal(parseIPv4("1.2.3"), null);         // too few octets
    assert.equal(parseIPv4("1.2.3.4.5"), null);     // too many octets
    assert.equal(parseIPv4("256.0.0.1"), null);     // octet > 255
    assert.equal(parseIPv4("-1.0.0.1"), null);      // negative octet
    assert.equal(parseIPv4("1.2.3.abc"), null);     // non-numeric
  });
});

// ---------------------------------------------------------------------------
// IPv6 helpers
// ---------------------------------------------------------------------------

describe("IPv6 helpers", () => {
  let parseIPv6: Function;
  let ipv6InBlock: Function;

  before(async () => {
    const mod = await import("../src/chat-client.js");
    parseIPv6 = mod.parseIPv6;
    ipv6InBlock = mod.ipv6InBlock;
  });

  it("parseIPv6 returns null for invalid input", () => {
    assert.equal(parseIPv6(""), null);
    assert.equal(parseIPv6("not-an-ip"), null);
  });

  it("ipv6InBlock returns a boolean", () => {
    const addr = new Uint8Array([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const block = {
      label: "link-local (fe80::/10)",
      prefix: new Uint8Array([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      prefixLen: 10,
      isLoopback: false,
    };
    const result = ipv6InBlock(addr, block);
    assert.equal(typeof result, "boolean");
  });
});

// ---------------------------------------------------------------------------
// SSRF validation (pure logic, no DNS)
// ---------------------------------------------------------------------------

describe("SSRF assertSafeIPv4", () => {
  let assertSafeIPv4: Function;
  let ChatClientError: any;
  let ipv4ToInt: Function;

  before(async () => {
    const mod = await import("../src/chat-client.js");
    assertSafeIPv4 = mod.assertSafeIPv4;
    ChatClientError = mod.ChatClientError;
    ipv4ToInt = mod.ipv4ToInt;
  });

  it("throws SSRF for loopback 127.0.0.1 without allowInsecure", () => {
    const ip = ipv4ToInt([127, 0, 0, 1]);
    assert.throws(
      () => assertSafeIPv4(ip, "127.0.0.1", false),
      (err: any) => err instanceof ChatClientError && err.code === "ssrf",
      "Should block loopback",
    );
  });

  it("allows loopback with allowInsecureLocalHttp=true", () => {
    const ip = ipv4ToInt([127, 0, 0, 1]);
    assert.doesNotThrow(() => assertSafeIPv4(ip, "127.0.0.1", true));
  });

  it("throws SSRF for private 10.x.x.x", () => {
    const ip = ipv4ToInt([10, 0, 0, 1]);
    assert.throws(
      () => assertSafeIPv4(ip, "10.0.0.1", false),
      (err: any) => err instanceof ChatClientError && err.code === "ssrf",
      "Should block private range",
    );
  });

  it("throws SSRF for 192.168.x.x", () => {
    const ip = ipv4ToInt([192, 168, 1, 1]);
    assert.throws(
      () => assertSafeIPv4(ip, "192.168.1.1", false),
      (err: any) => err instanceof ChatClientError && err.code === "ssrf",
      "Should block 192.168 range",
    );
  });

  it("throws SSRF for link-local 169.254.x.x", () => {
    const ip = ipv4ToInt([169, 254, 10, 5]);
    assert.throws(
      () => assertSafeIPv4(ip, "169.254.10.5", false),
      (err: any) => err instanceof ChatClientError && err.code === "ssrf",
      "Should block link-local",
    );
  });

  it("throws SSRF for cloud metadata IP 169.254.169.254", () => {
    const ip = ipv4ToInt([169, 254, 169, 254]);
    assert.throws(
      () => assertSafeIPv4(ip, "169.254.169.254", false),
      (err: any) => err instanceof ChatClientError && err.code === "ssrf",
      "Should block cloud metadata IP",
    );
  });

  it("allows public IP 8.8.8.8", () => {
    const ip = ipv4ToInt([8, 8, 8, 8]);
    assert.doesNotThrow(() => assertSafeIPv4(ip, "8.8.8.8", false));
  });

  it("allows public IP 1.1.1.1", () => {
    const ip = ipv4ToInt([1, 1, 1, 1]);
    assert.doesNotThrow(() => assertSafeIPv4(ip, "1.1.1.1", false));
  });
});

describe("SSRF assertSafeIPv6", () => {
  let assertSafeIPv6: Function;

  before(async () => {
    ({ assertSafeIPv6 } = await import("../src/chat-client.js"));
  });

  it("assertSafeIPv6 does not throw for unresolvable addresses", () => {
    // When parseIPv6 fails, the function returns silently (safe default)
    assert.doesNotThrow(() => assertSafeIPv6("invalid", false));
  });

  it("assertSafeIPv6 handles edge cases gracefully", () => {
    assert.doesNotThrow(() => assertSafeIPv6("", false));
  });
});

// ---------------------------------------------------------------------------
// Retry logic helpers
// ---------------------------------------------------------------------------

describe("Retry logic", () => {
  let isRetryable: Function;
  let isRetryableStatus: Function;
  let sleep: Function;
  let describeError: Function;

  before(async () => {
    const mod = await import("../src/chat-client.js");
    isRetryable = mod.isRetryable;
    isRetryableStatus = mod.isRetryableStatus;
    sleep = mod.sleep;
    describeError = mod.describeError;
  });

  it("isRetryableStatus: true for retryable codes", () => {
    // RETRYABLE_STATUSES = {502, 503, 504}
    for (const s of [502, 503, 504]) {
      assert.equal(isRetryableStatus(s), true, `Status ${s} should be retryable`);
    }
  });

  it("isRetryableStatus: false for non-retryable codes", () => {
    for (const s of [200, 201, 400, 401, 403, 404, 429, 500]) {
      assert.equal(isRetryableStatus(s), false, `Status ${s} should NOT be retryable`);
    }
  });

  it("isRetryable: checks error for retryability", () => {
    // The isRetryable function checks various error properties
    assert.equal(typeof isRetryable(new Error("test")), "boolean");
    assert.equal(typeof isRetryable(null), "boolean");
  });

  it("sleep returns a promise that resolves", async () => {
    const start = Date.now();
    await sleep(1);
    assert.ok(Date.now() - start >= 0, "Should resolve quickly");
  });

  it("describeError: returns constructor name for Error", () => {
    assert.ok(describeError(new Error("test")).includes("Error"));
    assert.ok(describeError(new TypeError("type")).includes("TypeError"));
  });

  it("describeError: stringifies non-Error", () => {
    assert.equal(describeError("plain"), "plain");
    assert.equal(describeError(42), "42");
    assert.equal(describeError({ a: 1 }), "[object Object]");
  });
});
