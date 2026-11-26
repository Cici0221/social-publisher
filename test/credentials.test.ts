import assert from "node:assert/strict";
import { test } from "node:test";
import * as OTPAuth from "otpauth";
import { createTotpChallenge, verifyTotpChallenge } from "../src/server/credentials";

test("TOTP enrollment requires a code and binds the expiring challenge to the user and credential version", () => {
  const previous = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
  try {
    const user = { id: "member-1", email: "member@example.test", passwordHash: "password version", totpSecret: "token version" };
    const now = 1_794_000_000_000;
    const setup = createTotpChallenge(user, now);
    const token = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.secret) });
    const current = token.generate({ timestamp: now });
    const different = Array.from({ length: 4 }, (_, index) => String(index).padStart(6, "0"))
      .find(code => token.validate({ token: code, timestamp: now, window: 1 }) === null);
    assert.ok(different);

    assert.deepEqual(verifyTotpChallenge(user, setup.challenge, current, now), { secret: setup.secret, step: BigInt(now / 30_000) });
    assert.throws(() => verifyTotpChallenge(user, setup.challenge, different, now), /验证码无效/);
    assert.throws(() => verifyTotpChallenge({ ...user, id: "member-2" }, setup.challenge, current, now), /失效/);
    assert.throws(() => verifyTotpChallenge({ ...user, passwordHash: "rotated" }, setup.challenge, current, now), /失效/);
    assert.throws(() => verifyTotpChallenge(user, `v0${setup.challenge.slice(2)}`, current, now), /失效/);
    assert.throws(() => verifyTotpChallenge(user, setup.challenge, current, now + 10 * 60_000), /过期/);
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previous;
  }
});
