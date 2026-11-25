import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "../../src/server/db";
import { encrypt } from "../../src/server/crypto";
import { retryTask } from "../../src/server/publications";
import { changeSchedule } from "../../src/server/schedules";
import { runTask } from "../../src/worker/task";
import { emptyDraft } from "../../src/lib/draft-schema";
import { localPublishTimeToDate } from "../../src/lib/publish-time";

const dbUrl = new URL(process.env.DATABASE_URL ?? "");
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:56379");
const local = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
if (process.env.APP_MODE !== "local" || !local(dbUrl) || !local(redisUrl)) throw new Error("需要本地测试环境。");

const client = db();
const contentIds: string[] = [];
const accountIds: string[] = [];
const actor = await client.user.findFirstOrThrow({ where: { role: "ADMIN", active: true },
  select: { id: true, email: true, name: true, active: true, role: true } });

async function seed(status: "SCHEDULED" | "PROCESSING", accountDisabled = false, checkpoint = false) {
  const now = Date.now();
  const account = await client.platformAccount.create({ data: { platform: "bluesky", mode: "MOCK",
    name: "排程验收", externalId: "mock-schedule-" + randomUUID(), status: accountDisabled ? "DISABLED" : "ACTIVE" } });
  const content = await client.content.create({ data: { ...emptyDraft(), status: "SUBMITTED", ownerId: actor.id, submittedAt: new Date() } });
  contentIds.push(content.id);
  accountIds.push(account.id);
  const id = randomUUID();
  const runAt = new Date(now + (status === "SCHEDULED" ? 86_400_000 : -1000));
  return client.publishTask.create({ data: {
    id, contentId: content.id, publisherId: actor.id, accountId: account.id, platform: "bluesky", language: "ZH",
    mode: "MOCK", status, runAt, nextRunAt: runAt,
    payload: { ...emptyDraft().versions.ZH, body: "队列定时测试", language: "ZH", options: {} },
    providerState: checkpoint ? encrypt(JSON.stringify({ data: {}, uploaded: true, submitted: true }), "publish-task:" + id) : null,
  } });
}

try {
  assert.equal(localPublishTimeToDate("2026-11-25T08:00", "Asia/Shanghai")?.toISOString(), "2026-11-25T00:00:00.000Z");
  assert.equal(localPublishTimeToDate("2026-11-25T08:00", "Asia/Tokyo")?.toISOString(), "2026-11-24T23:00:00.000Z");
  assert.equal(localPublishTimeToDate("2026-11-25T08:00", "Asia/Ho_Chi_Minh")?.toISOString(), "2026-11-25T01:00:00.000Z");
  const blocked = await seed("PROCESSING", true, true);
  await runTask(blocked.id);
  assert.equal((await client.publishTask.findUniqueOrThrow({ where: { id: blocked.id } })).status, "UNKNOWN");
  await assert.rejects(retryTask(actor, blocked.id), /失败任务可重试/);

  const cancelled = await seed("SCHEDULED");
  await changeSchedule(actor, cancelled.id, { action: "cancel" });
  await runTask(cancelled.id);
  assert.equal((await client.publishTask.findUniqueOrThrow({ where: { id: cancelled.id } })).status, "CANCELLED");

  const scheduled = await seed("SCHEDULED");
  const next = new Date(Date.now() + 3200);
  await changeSchedule(actor, scheduled.id, { action: "reschedule", runAt: next.toISOString() });
  assert.equal((await client.publishTask.findUniqueOrThrow({ where: { id: scheduled.id } })).runAt.toISOString(), next.toISOString());
  await runTask(scheduled.id);
  assert.equal((await client.publishTask.findUniqueOrThrow({ where: { id: scheduled.id } })).status, "SCHEDULED");

  // A new worker reconstructs its schedule from PostgreSQL, with no prior queue ticket.
  const worker = spawn(process.execPath, ["--import", "tsx", "src/worker/index.ts"], {
    env: { ...process.env, MOCK_FAIL_PLATFORM: "", APP_MODE: "local" }, stdio: "ignore",
  });
  try {
    let final;
    for (let index = 0; index < 64; index++) {
      final = await client.publishTask.findUniqueOrThrow({ where: { id: scheduled.id } });
      if (final.status === "SUCCESS") break;
      await delay(250);
    }
    assert.equal(final?.status, "SUCCESS");
    assert.ok(final?.publishedAt && final.publishedAt >= next);
    await assert.rejects(changeSchedule(actor, scheduled.id, { action: "cancel" }), /已开始执行或已结束/);
  } finally {
    if (worker.exitCode === null) {
      worker.kill("SIGTERM");
      await Promise.race([once(worker, "exit"), delay(3000)]);
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    }
  }
  console.info("通过：三时区、定时变更与取消、重启恢复、以及授权失效后的结果待核对防重发。");
} finally {
  await client.publishTask.deleteMany({ where: { contentId: { in: contentIds } } });
  await client.content.deleteMany({ where: { id: { in: contentIds } } });
  await client.platformAccount.deleteMany({ where: { id: { in: accountIds } } });
  await client.$disconnect();
}
