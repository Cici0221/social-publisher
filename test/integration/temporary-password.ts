import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import type { Role } from "../../src/generated/prisma/enums";
import { resetMemberCredential } from "../../src/server/credentials";
import { digest, encrypt, hashPassword } from "../../src/server/crypto";
import { db } from "../../src/server/db";
import { newTotpSecret } from "../../src/server/totp";

const base = new URL(process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000");
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const database = new URL(process.env.DATABASE_URL ?? "postgresql://unconfigured");
if (process.env.APP_MODE !== "local" ||
  ![database.hostname, base.hostname].every(host => ["localhost", "127.0.0.1", "[::1]"].includes(host))) {
  throw new Error("Integration fixtures require a local environment");
}

const client = db();
const members: string[] = [];
const password = "temporary password integration fixture";
const newPassword = "new permanent integration fixture password";
const changePath = "/change-temporary-password";
const code = (secret: string, offset = 0) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) })
  .generate({ timestamp: Date.now() + offset });

async function member(role: Role) {
  const id = randomUUID();
  const email = `temporary-password-${id}@example.test`;
  const secret = newTotpSecret();
  await client.user.create({
    data: { id, role, email, name: "临时密码验收", passwordHash: await hashPassword(password), totpSecret: encrypt(secret, `totp:${id}`) },
  });
  members.push(id);
  return { id, email, secret };
}

function request(path: string, options: RequestInit = {}) {
  return fetch(new URL(path, base), { redirect: "manual", ...options });
}

function login(email: string, password: string, value: string) {
  const headers = new Headers({ origin, "Content-Type": "application/json" });
  const ipHeader = process.env.LOGIN_CLIENT_IP_HEADER?.trim();
  if (ipHeader) headers.set(ipHeader, "192.0.2.28");
  return request("/api/auth/login", { method: "POST", headers, body: JSON.stringify({ email, password, code: value }) });
}

function loginCookie(response: Response) {
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/i);
  return cookie.split(";")[0];
}

function passwordForm(html: string, replacement: string) {
  const form = new FormData();
  for (const [, attributes] of html.matchAll(/<input\b([^>]+)>/g)) {
    const name = attributes.match(/\bname="([^"]+)"/)?.[1];
    if (!name?.startsWith("$ACTION_")) continue;
    const value = attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? "";
    form.append(name, value.replace(/&(quot|amp|lt|gt|#x27);/g, (_, entity: string) => (
      { quot: '"', amp: "&", lt: "<", gt: ">", "#x27": "'" }[entity] ?? ""
    )));
  }
  assert.ok([...form.keys()].some(key => key.startsWith("$ACTION_REF_")));
  form.append("newPassword", replacement);
  form.append("confirmPassword", replacement);
  return form;
}

try {
  const [admin, editor] = await Promise.all([member("ADMIN"), member("EDITOR")]);
  const oldToken = randomBytes(32).toString("base64url");
  const oldCookie = `publisher_session=${oldToken}`;
  await client.session.create({
    data: { digest: digest(oldToken), userId: editor.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  assert.equal((await request("/", { headers: { cookie: oldCookie } })).status, 200);

  const replacement = await resetMemberCredential(admin.id, editor.id, { factor: "password", password, code: code(admin.secret) });
  assert.equal(replacement.factor, "password");
  assert.equal((await request("/api/notifications", { headers: { cookie: oldCookie } })).status, 401);
  assert.equal((await login(editor.email, password, code(editor.secret))).status, 401);
  const loginResponse = await login(editor.email, replacement.password, code(editor.secret));
  assert.equal(loginResponse.status, 200);
  const cookie = loginCookie(loginResponse);

  const index = await request("/", { headers: { cookie } });
  assert.equal(index.status, 307);
  assert.equal(index.headers.get("location"), changePath);
  assert.equal((await request("/api/notifications", { headers: { cookie } })).status, 403);
  const session = await client.session.findFirstOrThrow({ where: { userId: editor.id } });
  assert.equal(session.passwordChangeOnly, true);
  assert.ok(session.expiresAt.getTime() - Date.now() <= 600_000);

  const page = await request(changePath, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /修改临时密码/);
  const submit = (replacement: string, token = cookie) => request(changePath, {
    method: "POST", headers: { origin: base.origin, cookie: token }, body: passwordForm(html, replacement),
  });

  const rejected = await submit(replacement.password);
  assert.equal(rejected.status, 200);
  assert.match(await rejected.text(), /新密码须与临时密码不同/);
  const saved = await submit(newPassword);
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get("location"), "/login");
  assert.equal((await request("/api/notifications", { headers: { cookie } })).status, 401);
  assert.equal(await client.session.count({ where: { userId: editor.id } }), 0);
  assert.equal((await client.user.findUniqueOrThrow({ where: { id: editor.id } })).mustChangePassword, false);
  assert.equal((await login(editor.email, replacement.password, code(editor.secret))).status, 401);
  const permanent = await login(editor.email, newPassword, code(editor.secret, 30_000));
  assert.equal(permanent.status, 200);
  const regularCookie = loginCookie(permanent);
  assert.equal((await request("/api/notifications", { headers: { cookie: regularCookie } })).status, 200);
  const regular = await request(changePath, { headers: { cookie: regularCookie } });
  assert.equal(regular.status, 307);
  assert.equal(regular.headers.get("location"), "/");
  assert.equal((await submit("unauthorized replacement password", regularCookie)).status, 303);
  assert.equal((await request("/api/notifications", { headers: { cookie: regularCookie } })).status, 200);

  const event = await client.auditLog.findFirstOrThrow({ where: { objectId: editor.id, action: "credentials.password.change" } });
  assert.deepEqual(event.details, { temporary: true });
  console.info("通过：临时密码限制会话、工作台和 API 访问，换密后撤销会话并用新密码重新登录。");
} finally {
  await client.session.deleteMany({ where: { userId: { in: members } } });
  await client.user.updateMany({ where: { id: { in: members } }, data: { active: false } });
  await client.$disconnect();
}
