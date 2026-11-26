import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import * as OTPAuth from "otpauth";
import { responseDiagnostics } from "../src/platforms/error-diagnostics";
import { checkPassword, decrypt, encrypt, hashPassword } from "../src/server/crypto";
import { AppError, assertSameOrigin, errorResponse, readJson } from "../src/server/errors";
import { loginClientAddress, withLoginPasswordSlot } from "../src/server/rate-limit";
import { enrollmentUri, newTotpSecret, validTotpStep } from "../src/server/totp";

test("encrypts with non-repeating IVs and authenticates purpose and ciphertext", () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const first = encrypt("sensitive", "platform:sample");
  const second = encrypt("sensitive", "platform:sample");
  assert.notEqual(first, second);
  assert.equal(decrypt(first, "platform:sample"), "sensitive");
  assert.throws(() => decrypt(first, "different-account"));
  const [version, iv, tag, bytes] = first.split(".");
  assert.throws(() => decrypt([version, iv, tag, (bytes[0] === "A" ? "B" : "A") + bytes.slice(1)].join("."), "platform:sample"));
});

test("stores salted password hashes and denies a different password", async () => {
  const clean = "sample password that is not in a database";
  const encoded = await hashPassword(clean);
  assert.notEqual(encoded, await hashPassword(clean));
  assert.equal(await checkPassword(clean, encoded), true);
  assert.equal(await checkPassword("incorrect", encoded), false);
  assert.equal(await checkPassword(clean), false);
});

test("issued secrets produce required verification codes and bounded time steps", () => {
  const secret = newTotpSecret();
  const email = "editor@example.test";
  const stamp = 1_800_000_000_000;
  const parsed = OTPAuth.URI.parse(enrollmentUri(email, secret));
  assert.ok(parsed instanceof OTPAuth.TOTP);
  const code = parsed.generate({ timestamp: stamp });
  assert.equal(validTotpStep(email, secret, code, stamp), BigInt(stamp / 30_000));
  assert.equal(validTotpStep(email, secret, "invalid", stamp), null);
  assert.equal(validTotpStep(email, secret, code, stamp + 120_000), null);
});

test("state-changing API calls accept only the configured origin", () => {
  process.env.APP_URL = "https://publisher.example.test";
  const request = (origin?: string) => new Request("https://publisher.example.test/api/auth/login", {
    method: "POST", headers: origin ? { origin } : {},
  });
  assert.doesNotThrow(() => assertSameOrigin(request("https://publisher.example.test")));
  assert.throws(() => assertSameOrigin(request("https://example.test")), AppError);
  assert.throws(() => assertSameOrigin(request()), AppError);
});

test("malformed JSON produces a 400 without leaking parser details", async () => {
  const request = new Request("http://localhost:3000/api/auth/login", { method: "POST", body: '{"' });
  await assert.rejects(readJson(request), error => error instanceof AppError && errorResponse(error).status === 400);
});

test("login uses a single client address from an explicitly trusted header", () => {
  const hints = new Headers({ "x-forwarded-for": "192.0.2.9", "x-real-ip": "2001:0db8::1" });
  assert.equal(loginClientAddress(hints, ""), undefined);
  assert.equal(loginClientAddress(hints, "x-real-ip"), "[2001:db8::1]");
  assert.throws(() => loginClientAddress(hints, "x-unused-ip"), AppError);
  hints.append("x-real-ip", "192.0.2.10");
  assert.throws(() => loginClientAddress(hints, "x-real-ip"), AppError);
});

test("excess password checks are rejected before allocating scrypt work", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const first = withLoginPasswordSlot(() => wait);
  const second = withLoginPasswordSlot(() => wait);
  try {
    await assert.rejects(withLoginPasswordSlot(() => assert.fail("must not start a third check")),
      error => error instanceof AppError && error.status === 429);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  await assert.rejects(withLoginPasswordSlot(async () => { throw new Error("fixture"); }), /fixture/);
  assert.equal(await withLoginPasswordSlot(async () => true), true);
});

test("platform diagnostics keep only bounded error fields and redact request credentials", async () => {
  const response = Response.json({
    error: { code: 403, message: "Forbidden for header-fixture at https://s3.example.test/a?sig=hidden" },
    access_token: "do-not-log-this",
    errors: [{ reason: "expired", detail: "refresh_token=form-fixture" }],
  });
  const diagnostic = await responseDiagnostics(response, new URL("https://api.example.test/?access_token=query-fixture"), {
    headers: { Authorization: "Bearer header-fixture" },
    body: new URLSearchParams({ refresh_token: "form-fixture" }),
  });
  assert.match(diagnostic ?? "", /code=403.*Forbidden.*reason=expired/);
  assert.doesNotMatch(diagnostic ?? "", /header-fixture|form-fixture|query-fixture|sig=|do-not-log-this/);
});
