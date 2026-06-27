import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AUX_MODEL_") || key === "AUX_ENV_FILE") {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

function runConfigProbe(env: NodeJS.ProcessEnv): string {
  return execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import { hasModelConfig, loadConfig } from './src/config.ts'; console.log(JSON.stringify({ hasModelConfig: hasModelConfig(), model: hasModelConfig() ? loadConfig().modelName : null }));",
    ],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf-8",
    },
  ).trim().split("\n").at(-1) ?? "";
}

test("config does not implicitly load project .env", () => {
  const output = runConfigProbe(cleanEnv());
  assert.deepEqual(JSON.parse(output), {
    hasModelConfig: false,
    model: null,
  });
});

test("config loads env file only when AUX_ENV_FILE is explicit", () => {
  const dir = mkdtempSync(join(tmpdir(), "wingman-env-"));
  const envFile = join(dir, ".env");
  writeFileSync(
    envFile,
    [
      "AUX_MODEL_API_KEY=test-key",
      "AUX_MODEL_NAME=explicit-env-model",
      "",
    ].join("\n"),
  );

  const output = runConfigProbe(cleanEnv({ AUX_ENV_FILE: envFile }));
  assert.deepEqual(JSON.parse(output), {
    hasModelConfig: true,
    model: "explicit-env-model",
  });
});
