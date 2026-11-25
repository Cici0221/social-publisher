import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "./audit";
import type { Actor } from "./auth";
import { db } from "./db";
import { AppError } from "./errors";

export const scheduleChange = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("reschedule"), runAt: z.iso.datetime({ offset: true }) }),
]);
const editable = ["WAITING_APPROVAL", "QUEUED", "SCHEDULED"] as const;

export async function changeSchedule(actor: Actor, id: string, change: z.infer<typeof scheduleChange>) {
  if (!["ADMIN", "EDITOR"].includes(actor.role)) throw new AppError("没有修改发布计划的权限。", 403);
  const now = new Date();
  const runAt = change.action === "reschedule" ? new Date(change.runAt) : null;
  if (runAt && (!Number.isFinite(+runAt) || +runAt <= +now)) {
    throw new AppError("请选择有效的未来发布时间。", 422);
  }
  try {
    await db().$transaction(async tx => {
      const task = await tx.publishTask.findFirst({ where: { id, publisherId: actor.id },
        select: { contentId: true, status: true, runAt: true, leaseToken: true, attempt: true } });
      if (!task) throw new AppError("找不到可操作的发布任务。", 404);
      await tx.$queryRaw`SELECT id FROM "Content" WHERE id = ${task.contentId} FOR UPDATE`;
      if (task.leaseToken || !editable.some(status => status === task.status)) {
        throw new AppError("任务已开始执行或已结束。", 409);
      }
      const waiting = task.status === "WAITING_APPROVAL";
      const changed = await tx.publishTask.updateMany({
        where: { id, publisherId: actor.id, status: task.status, attempt: task.attempt, leaseToken: null },
        data: runAt ? { runAt, nextRunAt: waiting ? null : runAt, status: waiting ? "WAITING_APPROVAL" : "SCHEDULED" } :
          { status: "CANCELLED", nextRunAt: null, errorCode: null, errorMessage: null },
      });
      if (!changed.count) throw new AppError("任务状态已变化，请刷新页面。", 409);
      if (waiting) {
        const remaining = runAt ? 1 : await tx.publishTask.count({ where: { contentId: task.contentId, status: "WAITING_APPROVAL" } });
        await tx.content.updateMany({
          where: { id: task.contentId, status: "IN_REVIEW" },
          data: { revision: { increment: 1 }, ...(remaining ? {} : { status: "SUBMITTED" }) },
        });
      }
      await audit(tx, actor.id, runAt ? "publish.reschedule" : "publish.cancel", id, {
        from: task.runAt.toISOString(), ...(runAt ? { to: runAt.toISOString() } : {}),
      });
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new AppError("任务状态已变化，请刷新页面。", 409);
    }
    throw error;
  }
}
