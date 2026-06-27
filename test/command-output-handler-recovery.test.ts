/**
 * Handler-level recovery tests — mock ChatClient, test handleCompressCommandOutput.
 *
 * 覆盖：
 * - 首次成功（valid + evidence verified）
 * - empty 非零退出 → coverage guard
 * - all-rejected → coverage guard
 * - partial_valid → analysis_status 联动
 * - parse_failure → 修复成功 / 修复失败
 * - schema_failure → 修复成功 / 修复失败
 * - transport_failure
 * - 修复调用次数 = 1
 * - 计数一致性
 */

import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ChatClient, ChatClientError } from "../src/chat-client.js";
import type { AppConfig } from "../src/config.js";
import { handleCompressCommandOutput } from "../src/tools/compress-command-output.js";

const savedModelApiKey = process.env.AUX_MODEL_API_KEY;

before(() => {
  process.env.AUX_MODEL_API_KEY = "test-key";
});

after(() => {
  if (savedModelApiKey) {
    process.env.AUX_MODEL_API_KEY = savedModelApiKey;
  } else {
    delete process.env.AUX_MODEL_API_KEY;
  }
});

// ── Fixture ──────────────────────────────────────────────

const TSC_OUTPUT = `src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/utils.ts(8,1): error TS2304: Cannot find name 'process'.
src/handler.ts(88,12): error TS2339: Property 'validated' does not exist.
Found 3 errors in 3 files.
`;

// ── Mock ChatClient ──────────────────────────────────────

class MockChatClient extends ChatClient {
  private _responses: string[] = [];
  private _callCount = 0;
  public lastSystemPrompt = "";
  public lastUserMessage = "";

  constructor(responses: string[]) {
    // Pass minimal config to parent
    super({
      modelApiKey: "test-key",
      modelBaseUrl: "https://api.test.com/v1",
      modelName: "test-model",
      modelTimeoutMs: 5000,
      modelAllowedHosts: ["api.test.com"],
      allowInsecureLocalHttp: false,
      workspaceRoot: "/tmp",
    } as AppConfig);
    this._responses = responses;
  }

  isAvailable(): boolean {
    return true;
  }

  async chat(systemPrompt: string, userMessage: string): Promise<string> {
    this.lastSystemPrompt = systemPrompt;
    this.lastUserMessage = userMessage;
    if (this._callCount >= this._responses.length) {
      throw new ChatClientError("no more mock responses configured", "http");
    }
    return this._responses[this._callCount++];
  }

  get callCount(): number {
    return this._callCount;
  }

  /** Return ChatClientError for transport failure */
  static transportFailure(): ChatClient {
    const mock = new MockChatClient([]);
    // Override chat to always throw
    mock.chat = async () => {
      throw new ChatClientError("connection refused", "http");
    };
    return mock;
  }
}

// ── Helper: make a valid model response ──────────────────

function validResponse(findings: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    detected_kind: "tsc_error",
    findings,
  });
}

function validFinding(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    finding_id: "f0",
    kind: "type_error",
    message: "Type error",
    file: "src/app.ts",
    line: 10,
    column: 5,
    error_code: "TS2345",
    evidence: "src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    confidence: "high",
    ...overrides,
  };
}

function parseResult(result: any) {
  const text = result.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

// ── Tests ───────────────────────────────────────────────

describe("handleCompressCommandOutput — model-first recovery (mocked)", () => {
  // ── Valid success ─────────────────────────────────────

  it("returns valid findings when model responds correctly", async () => {
    const client = new MockChatClient([
      validResponse([validFinding({ finding_id: "f0" }), validFinding({ finding_id: "f1", file: "src/utils.ts", line: 8, error_code: "TS2304", evidence: "src/utils.ts(8,1): error TS2304: Cannot find name 'process'." }), validFinding({ finding_id: "f2", file: "src/handler.ts", line: 88, error_code: "TS2339", evidence: "src/handler.ts(88,12): error TS2339: Property 'validated' does not exist." })]),
    ]);

    const result = await handleCompressCommandOutput(
      {
        command: "npx tsc --noEmit",
        output: TSC_OUTPUT,
        exit_code: 2,
        analysis_mode: "model_first",
      },
      { modelApiKey: "test", modelBaseUrl: "https://api.test.com/v1", modelName: "test", modelTimeoutMs: 5000, modelAllowedHosts: ["api.test.com"], allowInsecureLocalHttp: false, workspaceRoot: "/tmp" } as AppConfig,
      client,
    );

    const data = parseResult(result);
    assert.equal(result.isError, false);
    assert.equal(data.findings.length, 3, `Expected 3 findings, got ${data.findings.length}`);
    assert.equal(data._meta.model_response_status, "valid");
    assert.equal(data._meta.model_call_attempts, 1);
    assert.equal(data._meta.batches_succeeded, 1);
    assert.equal(data._meta.batches_failed, 0);
    assert.equal(data._meta.fallback_used, false);
    assert.equal(client.callCount, 1, "Should make exactly 1 call");
  });

  // ── Empty response + non-zero exit → coverage guard ──

  it("empty findings on non-zero exit triggers coverage guard (tsc fallback)", async () => {
    const client = new MockChatClient([
      validResponse([]), // model returns empty
    ]);

    const result = await handleCompressCommandOutput(
      {
        command: "npx tsc --noEmit",
        output: TSC_OUTPUT,
        exit_code: 2,
        analysis_mode: "model_first",
      },
      { modelApiKey: "test", modelBaseUrl: "https://api.test.com/v1", modelName: "test", modelTimeoutMs: 5000, modelAllowedHosts: ["api.test.com"], allowInsecureLocalHttp: false, workspaceRoot: "/tmp" } as AppConfig,
      client,
    );

    const data = parseResult(result);
    assert.equal(result.isError, false);
    assert.ok(data.findings.length > 0, "Coverage guard should produce findings");
    assert.equal(data.analysis_status, "partial");
    assert.equal(data._meta.fallback_used, true);
    assert.equal(data._meta.model_response_status, "empty");
    assert.equal(data._meta.model_call_attempts, 1);
  });

  // ── All findings rejected → coverage guard ─────────────

  it("all findings rejected on non-zero exit triggers coverage guard", async () => {
    const client = new MockChatClient([
      validResponse([
        {
          finding_id: "f0",
          kind: "type_error",
          message: "Missing required evidence",
          file: "src/app.ts",
          line: 10,
          confidence: "high",
          // missing evidence → should be rejected
        },
      ]),
    ]);

    const result = await handleCompressCommandOutput(
      {
        command: "npx tsc --noEmit",
        output: TSC_OUTPUT,
        exit_code: 2,
        analysis_mode: "model_first",
      },
      { modelApiKey: "test", modelBaseUrl: "https://api.test.com/v1", modelName: "test", modelTimeoutMs: 5000, modelAllowedHosts: ["api.test.com"], allowInsecureLocalHttp: false, workspaceRoot: "/tmp" } as AppConfig,
      client,
    );

    const data = parseResult(result);
    assert.ok(data.findings.length > 0, "Coverage guard should replace fully rejected model findings");
    assert.equal(data.analysis_status, "partial");
    assert.equal(data._meta.fallback_used, true);
    assert.equal(data._meta.model_response_status, "partial_valid");
    assert.equal(data._meta.model_findings_received, 1);
    assert.equal(data._meta.model_findings_rejected, 1);
  });

  // ── Partial valid → analysis_status not complete ──────

  it("partial_valid → analysis_status is NOT complete", async () => {
    const client = new MockChatClient([
      validResponse([
        validFinding({ finding_id: "f0", file: "src/app.ts", line: 10, evidence: "src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'." }),
        {
          finding_id: "f1",
          kind: "type_error",
          message: "Invalid — missing evidence",
          confidence: "high",
          // missing required evidence → rejected while f0 remains valid
        },
      ]),
    ]);

    const result = await handleCompressCommandOutput(
      {
        command: "npx tsc --noEmit",
        output: TSC_OUTPUT,
        exit_code: 2,
        analysis_mode: "model_first",
      },
      { modelApiKey: "test", modelBaseUrl: "https://api.test.com/v1", modelName: "test", modelTimeoutMs: 5000, modelAllowedHosts: ["api.test.com"], allowInsecureLocalHttp: false, workspaceRoot: "/tmp" } as AppConfig,
      client,
    );

    const data = parseResult(result);
    assert.equal(data.findings.length, 1);
    assert.equal(data.analysis_status, "partial");
    assert.equal(data._meta.model_response_status, "partial_valid");
    assert.equal(data._meta.model_findings_received, 2);
    assert.equal(data._meta.model_findings_rejected, 1);
    assert.equal(data._meta.fallback_used, false);
  });

  // ── Parse failure → repair success ────────────────────

  it("parse_failure → repair succeeds on 2nd attempt", async () => {
    const client = new MockChatClient([
      "not valid json{{{", // first call: garbage
      validResponse([validFinding()]), // second call: valid
    ]);

    const result = await handleCompressCommandOutput(
      {
        command: "npx tsc --noEmit",
        output: TSC_OUTPUT,
        exit_code: 2,
        analysis_mode: "model_first",
      },
      { modelApiKey: "test", modelBaseUrl: "https://api.test.com/v1", modelName: "test", modelTimeoutMs: 5000, modelAllowedHosts: ["api.test.com"], allowInsecureLocalHttp: false, workspaceRoot: "/tmp" } as AppConfig,
      client,
    );

    const data = parseResult(result);
    assert.equal(client.callCount, 2, "Should make 2 calls (1 normal + 1 repair)");
    assert.equal(data._meta.model_call_attempts, 2);
    assert.equal(data._meta.model_response_status, "valid");
    assert.ok(!data._meta.fallback_used, "Should not use fallback after successful repair");
  });

  // ── Parse failure → repair also fails ─────────────────

  it("parse_failure → repair also fails → fallback for tsc", async () => {
    const client = new MockChatClient([
      "broken json[[[", // first call: garbage
      "still broken[[[", // repair call: also garbage
    ]);

    const result = await handleCompressCommandOutput(
      {
        command: "npx tsc --noEmit",
        output: TSC_OUTPUT,
        exit_code: 2,
        analysis_mode: "model_first",
      },
      { modelApiKey: "test", modelBaseUrl: "https://api.test.com/v1", modelName: "test", modelTimeoutMs: 5000, modelAllowedHosts: ["api.test.com"], allowInsecureLocalHttp: false, workspaceRoot: "/tmp" } as AppConfig,
      client,
    );

    const data = parseResult(result);
    assert.equal(client.callCount, 2, "Should make exactly 2 calls total");
    assert.equal(data._meta.model_call_attempts, 2);
    assert.ok(data.findings.length > 0, "Failed repair should use the tsc coverage guard");
    assert.equal(data._meta.fallback_used, true);
    assert.equal(data.analysis_status, "partial");
  });

  // ── Schema failure → repair success ───────────────────

  it("schema_failure (bad envelope) → repair succeeds", async () => {
    const client = new MockChatClient([
      JSON.stringify({ detected_kind: "tsc_error" }), // missing findings array → schema_failure
      validResponse([validFinding()]), // repair works
    ]);

    const result = await handleCompressCommandOutput(
      {
        command: "npx tsc --noEmit",
        output: TSC_OUTPUT,
        exit_code: 2,
        analysis_mode: "model_first",
      },
      { modelApiKey: "test", modelBaseUrl: "https://api.test.com/v1", modelName: "test", modelTimeoutMs: 5000, modelAllowedHosts: ["api.test.com"], allowInsecureLocalHttp: false, workspaceRoot: "/tmp" } as AppConfig,
      client,
    );

    const data = parseResult(result);
    assert.equal(data._meta.model_response_status, "valid");
    assert.equal(data._meta.model_call_attempts, 2);
    assert.ok(!data._meta.fallback_used, "Should not use fallback after successful repair");
  });

  // ── Transport failure ─────────────────────────────────

  it("transport_failure (HTTP error) → fallback for tsc", async () => {
    const client = MockChatClient.transportFailure();

    // Override config to make model available
    const config = { modelApiKey: "test", modelBaseUrl: "https://api.test.com/v1", modelName: "test", modelTimeoutMs: 5000, modelAllowedHosts: ["api.test.com"], allowInsecureLocalHttp: false, workspaceRoot: "/tmp" } as AppConfig;

    const result = await handleCompressCommandOutput(
      {
        command: "npx tsc --noEmit",
        output: TSC_OUTPUT,
        exit_code: 2,
        analysis_mode: "model_first",
      },
      config,
      client,
    );

    const data = parseResult(result);
    assert.equal(data._meta.model_response_status, "transport_failure");
    assert.equal(data._meta.model_call_attempts, 2, "Should attempt repair after transport failure");
    assert.ok(data.findings.length > 0, "Transport failure should use the tsc coverage guard");
    assert.equal(data._meta.fallback_used, true);
    assert.equal(data.analysis_status, "partial");
  });

  // ── Repair call count limit ────────────────────────────

  it("makes at most 1 repair call (total ≤ 2 for small input)", async () => {
    const client = new MockChatClient([
      "garbage1",
      "garbage2",
    ]);

    const result = await handleCompressCommandOutput(
      {
        command: "npx tsc --noEmit",
        output: TSC_OUTPUT,
        exit_code: 2,
        analysis_mode: "model_first",
      },
      { modelApiKey: "test", modelBaseUrl: "https://api.test.com/v1", modelName: "test", modelTimeoutMs: 5000, modelAllowedHosts: ["api.test.com"], allowInsecureLocalHttp: false, workspaceRoot: "/tmp" } as AppConfig,
      client,
    );

    // Even with only 2 mock responses available, both get consumed (initial + repair)
    // But no 3rd call should be attempted
    assert.equal(client.callCount, 2, "Should make exactly 2 calls (1 normal + 1 repair max)");
  });

  // ── No repair when not non-zero exit ──────────────────

  it("no repair attempt when exit_code is undefined or 0", async () => {
    const client = new MockChatClient([
      "garbage",
      validResponse([validFinding()]), // would be repair, but shouldn't be called
    ]);

    const result = await handleCompressCommandOutput(
      {
        command: "npx tsc --noEmit",
        output: TSC_OUTPUT,
        exit_code: 0, // zero exit → no repair
        analysis_mode: "model_first",
      },
      { modelApiKey: "test", modelBaseUrl: "https://api.test.com/v1", modelName: "test", modelTimeoutMs: 5000, modelAllowedHosts: ["api.test.com"], allowInsecureLocalHttp: false, workspaceRoot: "/tmp" } as AppConfig,
      client,
    );

    assert.equal(client.callCount, 1, "Should NOT attempt repair when exit_code is 0");
    const data = parseResult(result);
    assert.equal(data._meta.model_call_attempts, 1);
    assert.equal(data._meta.model_response_status, "parse_failure");
  });
});

// ── Count consistency tests ──────────────────────────────

describe("handler count consistency", () => {
  it("verified + partial + unverified ≤ findings_retained (dedup aware)", async () => {
    const client = new MockChatClient([
      validResponse([
        validFinding({ finding_id: "f0", file: "src/app.ts", line: 10, evidence: "src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'." }),
        validFinding({ finding_id: "f1", file: "src/utils.ts", line: 8, evidence: "src/utils.ts(8,1): error TS2304: Cannot find name 'process'." }),
        validFinding({ finding_id: "f2", file: "src/handler.ts", line: 88, evidence: "src/handler.ts(88,12): error TS2339: Property 'validated' does not exist." }),
      ]),
    ]);

    const result = await handleCompressCommandOutput(
      {
        command: "npx tsc --noEmit",
        output: TSC_OUTPUT,
        exit_code: 2,
        analysis_mode: "model_first",
      },
      { modelApiKey: "test", modelBaseUrl: "https://api.test.com/v1", modelName: "test", modelTimeoutMs: 5000, modelAllowedHosts: ["api.test.com"], allowInsecureLocalHttp: false, workspaceRoot: "/tmp" } as AppConfig,
      client,
    );

    const data = parseResult(result);
    const { verified_findings = 0, partial_findings = 0, unverified_findings = 0, findings_retained = 0 } = data._meta;
    assert.ok(
      verified_findings + partial_findings + unverified_findings === findings_retained,
      `Count mismatch: ${verified_findings}v + ${partial_findings}p + ${unverified_findings}u ≠ ${findings_retained} retained`,
    );
  });
});
