import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import * as OTPAuth from "otpauth";
import { checkPassword, decrypt, encrypt, hashPassword } from "../src/server/crypto";
import { AppError, assertSameOrigin } from "../src/server/errors";
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
