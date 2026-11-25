import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import { db } from "../../src/server/db";
import { createMember } from "../../src/server/team";
import { emptyDraft } from "../../src/lib/draft-schema";

const base = new URL(process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000");
if (process.env.APP_MODE !== "local" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
  throw new Error("此测试只允许本地模拟发布。");
}
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const client = db();
const memberIds: string[] = [];
const fixtureAccounts: string[] = [];
const isolated = randomUUID().slice(0, 8);
const request = (path: string, cookie: string | undefined, method = "GET", body?: object) => fetch(new URL(path, base), {
  method, headers: { origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
  body: body && JSON.stringify(body),
});
const fixtureLogin = async (actorId: string, role: "EDITOR" | "ADMIN") => {
  const email = `pub-${role.toLowerCase()}-${isolated}@example.test`;
  const password = "testing isolated queue";
  const account = await createMember(actorId, { email, password, name: "发布验收", role });
  memberIds.push(account.id);
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(account.secret) }).generate();
  const response = await request("/api/auth/login", undefined, "POST", { email, password, code });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return { cookie, userId: account.id };
};

type Row = { id: string; platform: string; mode: string; status: string; errorCode: string | null };
async function poll(cookie: string, id: string, expect: (tasks: Row[]) => boolean) {
  for (let index = 0; index < 60; index++) {
    const response = await request("/api/publications/" + id, cookie);
    assert.equal(response.status, 200);
    const data = await response.json() as { tasks: Row[] };
    if (expect(data.tasks)) return data.tasks;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.fail("队列未完成状态变化。");
}

try {
  const root = await client.user.findFirstOrThrow({ where: { active: true, role: "ADMIN" }, select: { id: true } });
  const { cookie: admin } = await fixtureLogin(root.id, "ADMIN");
  const { cookie: editor } = await fixtureLogin(root.id, "EDITOR");
  const preference = await client.preference.findUniqueOrThrow({ where: { id: "workspace" } });
  assert.equal(preference.reviewRequired, false);
  assert.equal((await request("/api/accounts", editor, "POST", { action: "MOCK", platform: "bluesky", name: "无权绑定账号", language: "ZH" })).status, 403);

  for (const key of ["bluesky", "x", "youtube"]) {
    const response = await request("/api/accounts", admin, "POST", { action: "MOCK", platform: key, name: `${key} ${isolated}`, language: "ZH" });
    assert.equal(response.status, 201);
    const account = await response.json() as { id: string; credential?: string };
    assert.ok(!("credential" in account));
    fixtureAccounts.push(account.id);
  }

  const start = await request("/api/drafts", editor, "POST");
  assert.equal(start.status, 201);
  const { id } = await start.json() as { id: string };
  const draft = emptyDraft();
  draft.versions.ZH = { ...draft.versions.ZH, title: "队列验收", body: "这是一条模拟发布。", tags: ["验收测试"] };
  draft.selections = fixtureAccounts.map((accountId, index) => ({
    accountId, options: index === 1 ? { consent: true } : undefined,
  }));
  const saved = await request("/api/drafts/" + id, editor, "PUT", { revision: 0, draft });
  assert.equal(saved.status, 200);
  const revision = (await saved.json()).revision;
  assert.equal((await request("/api/publications/" + id, editor, "POST", { revision, skipInvalid: false })).status, 422);
  const raced = await Promise.all([0, 1].map(() => request("/api/publications/" + id, editor, "POST", { revision, skipInvalid: true })));
  assert.ok(raced.some(response => response.status === 202));
  assert.equal(raced.filter(response => response.status === 202).length, 1);

  const delivered = await poll(editor, id, rows => rows.length === 2 && rows.every(row => ["SUCCESS", "FAILED"].includes(row.status)));
  assert.equal(delivered.find(row => row.platform === "bluesky")?.status, "SUCCESS");
  const rejected = delivered.find(row => row.platform === "x");
  assert.ok(rejected);
  assert.equal(rejected.status, "FAILED", "Start worker with MOCK_FAIL_PLATFORM=x");
  assert.equal(rejected.errorCode, "mock_rejected");
  assert.equal((await request("/api/publications/tasks/" + rejected.id, editor, "POST")).status, 200);
  await poll(editor, id, rows => rows.some(row => row.id === rejected.id && row.status === "FAILED"));
  const records = await client.publishTask.findMany({ where: { contentId: id }, orderBy: { platform: "asc" } });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.attempt), [0, 1]);
  assert.ok(records.every(record => record.mode === "MOCK"));
  console.info("通过：HTTP 提交流程、BullMQ 两个独立任务、跳过无效目标、并发防重复、Bluesky 模拟成功及单任务重试。");
} finally {
  await client.platformAccount.updateMany({ where: { id: { in: fixtureAccounts } }, data: { status: "DISABLED" } });
  await client.user.updateMany({ where: { id: { in: memberIds } }, data: { active: false } });
  await client.$disconnect();
}
