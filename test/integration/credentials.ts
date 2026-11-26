import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import type { Role } from "../../src/generated/prisma/enums";
import { changePassword, changeTotp, recoverAdministrator, resetMemberCredential, startTotpChange } from "../../src/server/credentials";
import { checkPassword, decrypt, digest, encrypt, hashPassword } from "../../src/server/crypto";
import { db } from "../../src/server/db";
import { newTotpSecret } from "../../src/server/totp";

const url = new URL(process.env.DATABASE_URL ?? "");
if (process.env.APP_MODE !== "local" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  throw new Error("Integration fixtures require a local environment");
}

const client = db();
const members: string[] = [];
const password = "credential fixture password";
const code = (key: string, offset = 0) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(key) })
  .generate({ timestamp: Date.now() + offset });

async function member(role: Role) {
  const id = randomUUID();
  const email = `credentials-${id}@example.test`;
  const secret = newTotpSecret();
  await client.user.create({
    data: { id, email, name: "凭据验收", role, passwordHash: await hashPassword(password), totpSecret: encrypt(secret, `totp:${id}`) },
  });
  members.push(id);
  return { id, email, secret };
}

async function addSession(userId: string) {
  const expiresAt = new Date(Date.now() + 600_000);
  await client.session.create({ data: { digest: digest(randomUUID()), userId, expiresAt } });
  await client.oAuthState.create({ data: { digest: digest(randomUUID()), userId, expiresAt, platform: "youtube" } });
}

async function assertRevoked(userId: string) {
  assert.equal(await client.session.count({ where: { userId } }), 0);
  assert.equal(await client.oAuthState.count({ where: { userId } }), 0);
}

const record = (id: string) => client.user.findUniqueOrThrow({ where: { id } });
try {
  const [editor, admin, secondAdmin] = await Promise.all([member("EDITOR"), member("ADMIN"), member("ADMIN")]);
  const newPassword = "updated credential fixture password";

  await addSession(editor.id);
  await assert.rejects(resetMemberCredential(editor.id, admin.id, { factor: "password", password, code: code(editor.secret) }), /管理员权限/);
  const currentCode = code(editor.secret);
  await changePassword(editor.id, { password, code: currentCode, newPassword });
  assert.ok(await checkPassword(newPassword, (await record(editor.id)).passwordHash));
  await assertRevoked(editor.id);
  await assert.rejects(changePassword(editor.id, { password: newPassword, code: currentCode, newPassword: password }), /无效/);

  const setup = await startTotpChange(editor.id);
  await addSession(editor.id);
  const newCode = code(setup.secret);
  await changeTotp(editor.id, { password: newPassword, code: code(editor.secret, 30_000), challenge: setup.challenge, newCode });
  const changed = await record(editor.id);
  assert.equal(decrypt(changed.totpSecret, `totp:${editor.id}`), setup.secret);
  assert.notEqual(changed.lastTotpStep, null);
  await assertRevoked(editor.id);

  await addSession(editor.id);
  const resetPassword = await resetMemberCredential(admin.id, editor.id, { factor: "password", password, code: code(admin.secret) });
  assert.equal(resetPassword.factor, "password");
  assert.ok(await checkPassword(resetPassword.password, (await record(editor.id)).passwordHash));
  assert.equal((await record(editor.id)).totpSecret, changed.totpSecret);
  assert.equal((await record(editor.id)).mustChangePassword, true);
  await assertRevoked(editor.id);

  await addSession(editor.id);
  const resetTotp = await resetMemberCredential(secondAdmin.id, editor.id, { factor: "totp", password, code: code(secondAdmin.secret) });
  assert.equal(resetTotp.factor, "totp");
  const reset = await record(editor.id);
  assert.equal(decrypt(reset.totpSecret, `totp:${editor.id}`), resetTotp.secret);
  assert.equal(reset.lastTotpStep, null);
  assert.ok(await checkPassword(resetPassword.password, reset.passwordHash));
  assert.equal(reset.mustChangePassword, true);
  await assertRevoked(editor.id);

  await addSession(admin.id);
  await assert.rejects(recoverAdministrator(editor.email), /在职管理员/);
  const recovered = await recoverAdministrator(admin.email);
  const adminRecord = await record(admin.id);
  assert.ok(await checkPassword(recovered.password, adminRecord.passwordHash));
  assert.equal(decrypt(adminRecord.totpSecret, `totp:${admin.id}`), recovered.secret);
  assert.equal(adminRecord.lastTotpStep, null);
  assert.equal(adminRecord.mustChangePassword, true);
  await assertRevoked(admin.id);

  const log = await client.auditLog.findMany({ where: { objectId: { in: [editor.id, admin.id] } }, orderBy: { id: "asc" } });
  assert.deepEqual(log.map(entry => [entry.action, entry.actorId, entry.details]), [
    ["credentials.password.change", editor.id, {}],
    ["credentials.totp.change", editor.id, {}],
    ["credentials.password.reset", admin.id, {}],
    ["credentials.totp.reset", secondAdmin.id, {}],
    ["credentials.admin.recover", null, {}],
  ]);
  console.info("通过：密码和验证器修改、管理员重置、会话吊销、验证码防重放、管理员恢复及审计。");
} finally {
  await client.user.updateMany({ where: { id: { in: members } }, data: { active: false } });
  await client.$disconnect();
}
