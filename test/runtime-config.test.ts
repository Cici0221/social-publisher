import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { validateRuntimeConfig } from "../src/server/runtime-config";

test("production requires the deployment origin and a unique key", () => {
  const production = { APP_MODE: "production", APP_URL: "https://publisher.example.com",
    LOGIN_CLIENT_IP_HEADER: "X-Real-IP",
    ENCRYPTION_KEY: randomBytes(32).toString("base64") };
  assert.doesNotThrow(() => validateRuntimeConfig(production));
  assert.throws(() => validateRuntimeConfig({ ...production, APP_URL: "http://publisher.example.com" }), /HTTPS/);
  assert.throws(() => validateRuntimeConfig({ ...production, APP_URL: "https://publisher.example.com/work" }), /HTTPS/);
  assert.throws(() => validateRuntimeConfig({ ...production, BOOTSTRAP_ADMIN_PASSWORD: "local-publisher-only" }), /演示/);
  assert.throws(() => validateRuntimeConfig({ ...production, ENCRYPTION_KEY: "Y29kZXgta2V5LWZvci1sb2NhbC10ZXN0LXByb2plY3Q=" }), /密钥/);
  assert.throws(() => validateRuntimeConfig({ ...production, APP_MODE: "production-typo" }), /APP_MODE/);
  assert.doesNotThrow(() => validateRuntimeConfig({ APP_MODE: "local", APP_URL: "http://localhost:3000" }));
});

test("production requires a proxy header that Next.js does not populate automatically", () => {
  const production = { APP_MODE: "production", APP_URL: "https://publisher.example.com",
    ENCRYPTION_KEY: randomBytes(32).toString("base64") };
  assert.throws(() => validateRuntimeConfig(production), /LOGIN_CLIENT_IP_HEADER/);
  assert.throws(() => validateRuntimeConfig({ ...production, LOGIN_CLIENT_IP_HEADER: "  " }), /LOGIN_CLIENT_IP_HEADER/);
  assert.throws(() => validateRuntimeConfig({ ...production, LOGIN_CLIENT_IP_HEADER: "X-Forwarded-For" }), /代理专用请求头/);
  assert.throws(() => validateRuntimeConfig({ ...production, LOGIN_CLIENT_IP_HEADER: "bad name" }), /有效的 HTTP 请求头/);
  assert.doesNotThrow(() => validateRuntimeConfig({ ...production, LOGIN_CLIENT_IP_HEADER: "X-Real-IP" }));
});
