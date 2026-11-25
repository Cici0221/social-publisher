import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { validateRuntimeConfig } from "../src/server/runtime-config";

test("production requires the deployment origin and a unique key", () => {
  const production = { APP_MODE: "production", APP_URL: "https://publisher.example.com",
    ENCRYPTION_KEY: randomBytes(32).toString("base64") };
  assert.doesNotThrow(() => validateRuntimeConfig(production));
  assert.throws(() => validateRuntimeConfig({ ...production, APP_URL: "http://publisher.example.com" }), /HTTPS/);
  assert.throws(() => validateRuntimeConfig({ ...production, APP_URL: "https://publisher.example.com/work" }), /HTTPS/);
  assert.throws(() => validateRuntimeConfig({ ...production, BOOTSTRAP_ADMIN_PASSWORD: "local-publisher-only" }), /演示/);
  assert.throws(() => validateRuntimeConfig({ ...production, ENCRYPTION_KEY: "Y29kZXgta2V5LWZvci1sb2NhbC10ZXN0LXByb2plY3Q=" }), /密钥/);
  assert.throws(() => validateRuntimeConfig({ ...production, APP_MODE: "production-typo" }), /APP_MODE/);
  assert.doesNotThrow(() => validateRuntimeConfig({ APP_MODE: "local", APP_URL: "http://localhost:3000" }));
});
