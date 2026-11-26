import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "./audit";
import { encrypt, hashPassword } from "./crypto";
import { db } from "./db";
import { AppError } from "./errors";
import { cancelDisabledPublisherSchedules } from "./schedules";
import { enrollmentUri, newTotpSecret } from "./totp";

export const memberSchema = z.object({
  email: z.string().trim().email().max(254).transform(email => email.toLowerCase()),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["ADMIN", "EDITOR", "REVIEWER"]),
  password: z.string().min(12).max(128),
});

export async function createMember(actorId: string, data: z.infer<typeof memberSchema>) {
  const id = randomUUID();
  const secret = newTotpSecret();
  const passwordHash = await hashPassword(data.password);
  const record = await db().$transaction(async tx => {
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, active: true } });
    if (!actor?.active || actor.role !== "ADMIN") throw new AppError("管理员权限已变更。", 403);
    if (await tx.user.findUnique({ where: { email: data.email }, select: { id: true } })) {
      throw new AppError("该邮箱已登记。", 409);
    }
    const user = await tx.user.create({
      data: { id, email: data.email, name: data.name, role: data.role, passwordHash, totpSecret: encrypt(secret, "totp:" + id) },
      select: { id: true },
    });
    await audit(tx, actorId, "member.create", user.id, { role: data.role });
    return user;
  }, { isolationLevel: "Serializable" });
  return { id: record.id, secret, uri: enrollmentUri(data.email, secret) };
}

export async function editMember(actorId: string, id: string, role: z.infer<typeof memberSchema>["role"], active: boolean) {
  if (actorId === id) throw new AppError("请由另一位管理员修改你的账号权限。", 409);
  try {
    await db().$transaction(async tx => {
      const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, active: true } });
      if (!actor?.active || actor.role !== "ADMIN") throw new AppError("管理员权限已变更。", 403);
      const target = await tx.user.findUnique({ where: { id }, select: { role: true, active: true } });
      if (!target) throw new AppError("成员不存在。", 404);
      if (target.role === role && target.active === active) {
        if (!active) await cancelDisabledPublisherSchedules(tx, actorId, id);
        return;
      }
      if (target.active && target.role === "REVIEWER" && (!active || role !== "REVIEWER")) {
        const other = await tx.user.findFirst({ where: { id: { not: id }, role: "REVIEWER", active: true }, select: { id: true } });
        if (!other) {
          const preference = await tx.preference.findUnique({ where: { id: "workspace" } });
          const pending = await tx.content.findFirst({ where: { status: "IN_REVIEW" }, select: { id: true } });
          if (preference?.reviewRequired || pending) throw new AppError("请先安排另一位有效审核人，或关闭审核并处理完待审核内容。", 409);
        }
      }
      await tx.user.update({ where: { id }, data: { role, active } });
      await tx.session.deleteMany({ where: { userId: id } });
      const cancelledTasks = !active ? await cancelDisabledPublisherSchedules(tx, actorId, id) : 0;
      await audit(tx, actorId, "member.permissions", id, { from: target, to: { role, active }, cancelledTasks });
    }, { isolationLevel: "Serializable", timeout: 15_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new AppError("成员或任务状态已变化，请重试。", 409);
    }
    throw error;
  }
}
