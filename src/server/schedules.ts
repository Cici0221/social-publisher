import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "./audit";
import type { Actor } from "./auth";
import { db, type Transaction } from "./db";
import { AppError } from "./errors";
import { lockPublisher, managedTaskScope } from "./publisher-access";

export const scheduleChange = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("reschedule"), runAt: z.iso.datetime({ offset: true }) }),
]);
const editable = ["WAITING_APPROVAL", "QUEUED", "SCHEDULED"] as const;

export const publisherDisabled = {
  errorCode: "publisher_disabled", errorMessage: "发布人已停用，任务已取消。",
} as const;

async function updateReviewQueue(tx: Transaction, contentId: string) {
  const remaining = await tx.publishTask.count({ where: { contentId, status: "WAITING_APPROVAL" } });
  await tx.content.updateMany({
    where: { id: contentId, status: "IN_REVIEW" },
    data: { revision: { increment: 1 }, ...(remaining ? {} : { status: "SUBMITTED" }) },
  });
}

export async function cancelDisabledPublisherSchedules(tx: Transaction, actorId: string, publisherId: string) {
  const waiting = await tx.publishTask.findMany({
    where: { publisherId, status: "WAITING_APPROVAL" }, distinct: ["contentId"], select: { contentId: true },
  });
  if (waiting.length) {
    await tx.$queryRaw`SELECT "id" FROM "Content" WHERE "id" IN (${Prisma.join(waiting.map(task => task.contentId))}) ORDER BY "id" FOR UPDATE`;
  }
  const cancelled = await tx.publishTask.updateManyAndReturn({
    where: { publisherId, status: { in: [...editable] } },
    data: { status: "CANCELLED", nextRunAt: null, leaseToken: null, leaseExpiresAt: null, ...publisherDisabled },
    select: { id: true, contentId: true, platform: true, runAt: true },
  });
  for (const item of waiting) await updateReviewQueue(tx, item.contentId);
  for (const task of cancelled) {
    await audit(tx, actorId, "publish.cancel", task.id, {
      contentId: task.contentId, platform: task.platform, from: task.runAt.toISOString(), reason: publisherDisabled.errorCode,
    });
  }
  return cancelled.length;
}

export async function changeSchedule(actor: Actor, id: string, change: z.infer<typeof scheduleChange>) {
  const now = new Date();
  const runAt = change.action === "reschedule" ? new Date(change.runAt) : null;
  if (runAt && (!Number.isFinite(+runAt) || +runAt <= +now)) {
    throw new AppError("请选择有效的未来发布时间。", 422);
  }
  try {
    await db().$transaction(async tx => {
      const scope = await managedTaskScope(tx, actor);
      const task = await tx.publishTask.findFirst({ where: { id, ...scope },
        select: { contentId: true, status: true, runAt: true, leaseToken: true, attempt: true, publisherId: true } });
      if (!task) throw new AppError("找不到可操作的发布任务。", 404);
      if (runAt && task.publisherId !== actor.id && !(await lockPublisher(tx, task.publisherId))?.active) {
        throw new AppError("发布人已停用，无法修改定时。", 409);
      }
      await tx.$queryRaw`SELECT id FROM "Content" WHERE id = ${task.contentId} FOR UPDATE`;
      if (task.leaseToken || !editable.some(status => status === task.status)) {
        throw new AppError("任务已开始执行或已结束。", 409);
      }
      const waiting = task.status === "WAITING_APPROVAL";
      const changed = await tx.publishTask.updateMany({
        where: { id, ...scope, status: task.status, attempt: task.attempt, leaseToken: null },
        data: runAt ? { runAt, nextRunAt: waiting ? null : runAt, status: waiting ? "WAITING_APPROVAL" : "SCHEDULED" } :
          { status: "CANCELLED", nextRunAt: null, errorCode: null, errorMessage: null },
      });
      if (!changed.count) throw new AppError("任务状态已变化，请刷新页面。", 409);
      if (waiting) await updateReviewQueue(tx, task.contentId);
      await audit(tx, actor.id, runAt ? "publish.reschedule" : "publish.cancel", id, {
        from: task.runAt.toISOString(), publisherId: task.publisherId, ...(runAt ? { to: runAt.toISOString() } : {}),
      });
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new AppError("任务状态已变化，请刷新页面。", 409);
    }
    throw error;
  }
}
