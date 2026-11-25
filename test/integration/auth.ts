import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import { db } from "../../src/server/db";
import { createMember } from "../../src/server/team";

const url = new URL(process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000");
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || process.env.APP_MODE !== "local") {
  throw new Error("Integration fixtures require a local environment");
}

const client = db();
const code = (secret: string) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
const login = (email: string, password: string, value: string) => fetch(new URL("/api/auth/login", url), {
  method: "POST", headers: { origin, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, code: value }),
});
try {
  assert.equal((await fetch(new URL("/api/health", url))).status, 200);
  const anon = await fetch(new URL("/", url), { redirect: "manual" });
  assert.equal(anon.status, 307);
  assert.equal(anon.headers.get("location"), "/login");
  const admin = await client.user.findFirstOrThrow({ where: { active: true, role: "ADMIN" }, select: { id: true } });
  const suffix = randomUUID().slice(0, 8);
  const editorEmail = `qa-editor-${suffix}@example.test`;
  const reviewerEmail = `qa-reviewer-${suffix}@example.test`;
  const password = "local integration account";
  const editor = await createMember(admin.id, { email: editorEmail, name: "验收编辑", role: "EDITOR", password });
  const reviewer = await createMember(admin.id, { email: reviewerEmail, name: "验收审核人", role: "REVIEWER", password });
  const editorCode = code(editor.secret);
  const malformedCode = (Number(editorCode) + 30) % 1_000_000;
  assert.equal((await login(editorEmail, password, String(malformedCode).padStart(6, "0"))).status, 401);
  for (const [email, otp] of [[editorEmail, editorCode], [reviewerEmail, code(reviewer.secret)]]) {
    const response = await login(email, password, otp);
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/i);
    const cookie = setCookie.split(";")[0];
    const dashboard = await fetch(new URL("/", url), { headers: { cookie }, redirect: "manual" });
    assert.equal(dashboard.status, 200);
    const forbidden = await fetch(new URL("/admin/members", url), { headers: { cookie }, redirect: "manual" });
    assert.equal(forbidden.status, 307);
    assert.equal(forbidden.headers.get("location"), "/");
    assert.equal((await login(email, password, otp)).status, 401);
    const logout = await fetch(new URL("/api/auth/logout", url), { method: "POST", headers: { origin, cookie }, redirect: "manual" });
    assert.equal(logout.status, 303);
    assert.equal((await fetch(new URL("/", url), { headers: { cookie }, redirect: "manual" })).status, 307);
  }
  const audit = await client.auditLog.findFirstOrThrow({ where: { action: "member.create", objectId: editor.id } });
  await assert.rejects(client.auditLog.delete({ where: { id: audit.id } }), /append-only/i);
  await client.user.updateMany({ where: { id: { in: [editor.id, reviewer.id] } }, data: { active: false } });
  console.info("通过：真实 PostgreSQL 迁移、来访者限制、双重验证和重放阻止、角色隔离、退出和日志防删。");
} finally {
  await client.$disconnect();
}
