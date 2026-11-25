import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Role } from "../../src/generated/prisma/enums";
import type { Actor } from "../../src/server/auth";
import { db } from "../../src/server/db";
import { AppError } from "../../src/server/errors";
import { changeSchedule } from "../../src/server/schedules";
import { submitPublication } from "../../src/server/publications";
import { decideReview, reviewQueue, reviewSettings, reviewingContent, setReviewRequired } from "../../src/server/reviews";

const connection = process.env.REVIEW_TEST_DATABASE_URL;
if (!connection) throw new Error("请用 REVIEW_TEST_DATABASE_URL 指向已迁移的独立 PostgreSQL 测试库。");
const database = new URL(connection);
if (!["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    !/^\/publisher_review_[a-z0-9_]+$/.test(database.pathname)) {
  throw new Error("测试库须位于本机，名称以 publisher_review_ 开头。");
}
process.env.DATABASE_URL = connection;

const client = db();
const unique = () => randomUUID().replaceAll("-", "").slice(0, 10);

function appError(status: number) {
  return (error: unknown) => error instanceof AppError && error.status === status;
}

async function fixture(role: Role, name: string): Promise<Actor> {
  const email = `review-fixture-${unique()}@example.test`;
  return client.user.create({
    data: { email, name, role, passwordHash: "unused", totpSecret: "unused" },
    select: { id: true, email: true, name: true, role: true, active: true },
  });
}

try {
  const admin = await fixture("ADMIN", "测试管理员");
  const editor = await fixture("EDITOR", "测试编辑");
  const reviewer = await fixture("REVIEWER", "测试审核人");
  const secondReviewer = await fixture("REVIEWER", "测试并行审核人");
  assert.equal((await reviewSettings(admin)).required, false);
  await assert.rejects(setReviewRequired(editor, { required: true }), appError(403));

  const account = await client.platformAccount.create({
    data: { platform: "bluesky", externalId: "mock-" + unique(), name: "蓝天测试", status: "ACTIVE",
      mode: "MOCK", credential: "test-value-must-not-be-in-review" },
  });
  const secondAccount = await client.platformAccount.create({
    data: { platform: "facebook", externalId: "mock-" + unique(), name: "主页测试", status: "ACTIVE", mode: "MOCK" },
  });
  const clock = new Date(Date.now() + 12 * 60_000);
  const tag = "测试话题";
  const copy = { title: "审核测试", body: "原始文案", tags: [tag], assetIds: [], coverId: null };
  const createDraft = () => client.content.create({
    data: { ownerId: editor.id, versions: { ZH: copy }, overrides: {}, selections: [
      { accountId: account.id, runAt: null }, { accountId: secondAccount.id, runAt: clock.toISOString() },
    ] },
  });
  const withoutReview = await createDraft();
  await submitPublication(editor, withoutReview.id, withoutReview.revision, false);
  assert.equal((await client.content.findUniqueOrThrow({ where: { id: withoutReview.id } })).status, "SUBMITTED");
  assert.deepEqual((await client.publishTask.findMany({ where: { contentId: withoutReview.id } })).map(row => row.status).sort(),
    ["QUEUED", "SCHEDULED"]);

  await setReviewRequired(admin, { required: true });
  assert.equal((await reviewSettings(admin)).required, true);
  const awaiting = await createDraft();
  await submitPublication(editor, awaiting.id, awaiting.revision, false);
  const before = await client.publishTask.findMany({ where: { contentId: awaiting.id } });
  assert.equal(before.length, 2);
  assert.ok(before.every(task => task.status === "WAITING_APPROVAL" && task.nextRunAt === null));
  assert.equal(await client.notification.count({ where: { userId: reviewer.id, kind: "review_waiting" } }), 1);
  assert.equal((await reviewQueue(reviewer, null)).items.some(item => item.id === awaiting.id), true);
  await assert.rejects(reviewingContent(editor, awaiting.id), appError(403));
  const snapshot = await reviewingContent(reviewer, awaiting.id);
  assert.equal(snapshot.canApprove, true);
  assert.ok(snapshot.items.every(row => row.copy?.body.includes(copy.body)));
  assert.ok(snapshot.items.some(row => row.scheduled && row.runAt === clock.toISOString()));
  assert.ok(!JSON.stringify(snapshot).includes("test-value-must-not-be-in-review"));

  const moved = new Date(Date.now() + 35 * 60_000);
  await changeSchedule(editor, before.find(row => row.accountId === secondAccount.id)!.id, { action: "reschedule", runAt: moved.toISOString() });
  await assert.rejects(decideReview(reviewer, awaiting.id, { decision: "approve", revision: snapshot.revision, note: "旧快照" }), appError(409));
  const refreshed = await reviewingContent(reviewer, awaiting.id);
  assert.ok(refreshed.items.some(row => row.scheduled && row.runAt === moved.toISOString()));
  const approval = { decision: "approve", revision: refreshed.revision, note: "已复核。" };
  await assert.rejects(decideReview(admin, awaiting.id, approval), appError(403));
  const concurrent = await Promise.allSettled([
    decideReview(reviewer, awaiting.id, approval), decideReview(secondReviewer, awaiting.id, approval),
  ]);
  assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
  const loser = concurrent.find(result => result.status === "rejected");
  assert.ok(loser?.status === "rejected" && appError(409)(loser.reason));
  assert.equal(await client.review.count({ where: { contentId: awaiting.id } }), 1);
  const released = await client.publishTask.findMany({ where: { contentId: awaiting.id } });
  for (const task of released) {
    const original = before.find(row => row.id === task.id)!;
    assert.equal(+task.runAt, task.accountId === secondAccount.id ? +moved : +original.runAt);
    assert.equal(task.status, task.accountId === secondAccount.id ? "SCHEDULED" : "QUEUED");
    assert.ok(task.nextRunAt && +task.nextRunAt >= +original.runAt);
    if (task.status === "SCHEDULED") assert.equal(+task.nextRunAt!, +moved);
  }
  assert.equal(await client.notification.count({ where: { userId: editor.id, kind: "review_approved" } }), 1);

  const returned = await createDraft();
  await submitPublication(editor, returned.id, returned.revision, false);
  const beforeReturn = await reviewingContent(reviewer, returned.id);
  const note = "请补充来源。";
  await decideReview(reviewer, returned.id, { decision: "return", revision: beforeReturn.revision, note });
  const updated = await client.content.findUniqueOrThrow({ where: { id: returned.id } });
  assert.equal(updated.status, "RETURNED");
  assert.equal(updated.reviewNote, note);
  const cancelled = await client.publishTask.findMany({ where: { contentId: returned.id } });
  assert.ok(cancelled.every(task => task.status === "CANCELLED" && task.nextRunAt === null && task.errorCode === "review_returned"));
  assert.equal(await client.notification.count({ where: { userId: editor.id, kind: "review_returned" } }), 1);
  assert.equal(await client.auditLog.count({ where: { action: "review.returned", objectId: returned.id } }), 1);
  const taskIds = cancelled.map(item => item.id).sort();
  await submitPublication(editor, returned.id, updated.revision, false);
  const resubmitted = await client.publishTask.findMany({ where: { contentId: returned.id } });
  assert.deepEqual(resubmitted.map(item => item.id).sort(), taskIds);
  assert.ok(resubmitted.every(item => item.status === "WAITING_APPROVAL" && item.attempt === 1));
  await setReviewRequired(admin, { required: false });
  assert.equal((await reviewSettings(admin)).required, false);
  assert.equal(await client.auditLog.count({ where: { action: "review.settings_changed" } }), 2);
  console.info("通过：未开启时直接提交、开启后等待审核、快照不含凭据、并行审核只产生一个结果，以及定时保留、退回和通知审计。");
} finally { await client.$disconnect(); }
