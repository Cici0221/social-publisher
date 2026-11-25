import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "./audit";
import { encrypt, hashPassword } from "./crypto";
import { db } from "./db";
import { AppError } from "./errors";
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
  await db().$transaction(async tx => {
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, active: true } });
    if (!actor?.active || actor.role !== "ADMIN") throw new AppError("管理员权限已变更。", 403);
    const target = await tx.user.findUnique({ where: { id }, select: { role: true, active: true } });
    if (!target) throw new AppError("成员不存在。", 404);
    if (target.role === role && target.active === active) return;
    await tx.user.update({ where: { id }, data: { role, active } });
    await tx.session.deleteMany({ where: { userId: id } });
    await audit(tx, actorId, "member.permissions", id, { from: target, to: { role, active } });
  }, { isolationLevel: "Serializable" });
}
