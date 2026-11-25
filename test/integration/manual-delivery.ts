import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Actor } from "../../src/server/auth";
import { db } from "../../src/server/db";
import { AppError } from "../../src/server/errors";
import { confirmManual, getManualDelivery, saveManualAccount } from "../../src/server/manual";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://unconfigured");
if (process.env.APP_MODE !== "local" || !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname)) {
  throw new Error("Manual publishing fixtures require APP_MODE=local and a local database");
}

const client = db();
const fixture = randomUUID();
const fixtureIds = { users: [] as string[], accounts: [] as string[], contents: [] as string[], tasks: [] as string[] };
const appStatus = (status: number) => (error: unknown) => error instanceof AppError && error.status === status;

async function actor(role: Actor["role"], name: string) {
  const user = await client.user.create({ data: {
    role, name, email: `${name}-${fixture}@example.test`, passwordHash: "qa-fixture", totpSecret: "qa-fixture",
  }, select: { id: true, role: true, active: true, name: true, email: true } });
  fixtureIds.users.push(user.id);
  return user;
}

try {
  const [admin, editor, other] = await Promise.all([actor("ADMIN", "test-admin"), actor("EDITOR", "test-owner"), actor("EDITOR", "test-other")]);
  await assert.rejects(saveManualAccount(editor, "xiaohongshu", fixture, "ZH"), appStatus(403));
  await assert.rejects(saveManualAccount(admin, "xiaohongshu", fixture, "ZH", "https://wrong.example.test/"), appStatus(422));
  const account = await saveManualAccount(admin, "xiaohongshu", fixture, "ZH");
  fixtureIds.accounts.push(account.id);
  assert.equal(account.backendUrl, "https://creator.xiaohongshu.com/");
  assert.equal(account.mode, "MANUAL");
  assert.equal((await client.platformAccount.findUniqueOrThrow({ where: { id: account.id } })).credential, null);

  const copy = { title: "测试标题", body: "测试正文", tags: [], assetIds: [], coverId: null };
  const content = await client.content.create({ data: {
    ownerId: editor.id, status: "SUBMITTED", versions: { ZH: copy }, overrides: {}, selections: [{ accountId: account.id }],
  } });
  fixtureIds.contents.push(content.id);
  const task = await client.publishTask.create({ data: {
    contentId: content.id, accountId: account.id, publisherId: editor.id, mode: "MANUAL", platform: account.platform,
    language: "ZH", status: "MANUAL", payload: { ...copy, language: "ZH", options: {} }, runAt: new Date(),
  } });
  fixtureIds.tasks.push(task.id);
  const read = await getManualDelivery(editor, task.id);
  assert.equal(read.copy, "测试标题\n\n测试正文");
  assert.equal(read.canConfirm, true);
  assert.equal((await getManualDelivery(admin, task.id)).canConfirm, false);
  await assert.rejects(getManualDelivery(other, task.id), appStatus(404));

  const confirmed = { postUrl: "https://www.xiaohongshu.com/explore/example", actualTitle: "发布标题", actualBody: "实际正文" };
  await assert.rejects(confirmManual(admin, task.id, confirmed), appStatus(404));
  await assert.rejects(confirmManual(editor, task.id, { postUrl: "https://channels.weixin.qq.com/sph/example" }), appStatus(422));
  const results = await Promise.all([confirmManual(editor, task.id, confirmed), confirmManual(editor, task.id, confirmed)]);
  assert.deepEqual(results[0], results[1]);
  await assert.rejects(confirmManual(editor, task.id, { ...confirmed, actualBody: "另一份文案" }), appStatus(409));

  const saved = await client.publishTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(saved.status, "SUCCESS");
  assert.equal(saved.publisherId, editor.id);
  assert.equal(saved.confirmerId, editor.id);
  assert.equal(saved.publishedAt?.toISOString(), results[0].publishedAt);
  assert.equal(saved.postUrl, confirmed.postUrl);
  assert.equal((await getManualDelivery(editor, task.id)).copy, "发布标题\n\n实际正文");
  assert.equal(await client.auditLog.count({ where: { objectId: task.id, action: "publish.manual.confirm" } }), 1);
  assert.equal(await client.notification.count({ where: { userId: editor.id, dedupeKey: `manual-published:${task.id}` } }), 1);
  console.info("通过：半自动账号登记、官方链接限制、发布人专属回填、并发幂等、实际文案、日志和通知。");
} finally {
  await client.notification.deleteMany({ where: { userId: { in: fixtureIds.users } } });
  await client.publishTask.deleteMany({ where: { id: { in: fixtureIds.tasks } } });
  await client.content.deleteMany({ where: { id: { in: fixtureIds.contents } } });
  await client.platformAccount.deleteMany({ where: { id: { in: fixtureIds.accounts } } });
  // Audit rows are immutable, so fixture users with audit entries are deactivated.
  await client.user.updateMany({ where: { id: { in: fixtureIds.users } }, data: { active: false } });
  await client.$disconnect();
}
