import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Role } from "@/generated/prisma/enums";
import { audit } from "./audit";
import { checkPassword, decrypt, digest } from "./crypto";
import { db } from "./db";
import { AppError } from "./errors";
import { validTotpStep } from "./totp";

const sessionCookie = "publisher_session";
const sessionLifetime = 8 * 60 * 60 * 1000;
const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  password: z.string().min(1).max(128),
  code: z.string().regex(/^\d{6}$/),
});
const publicUser = { id: true, email: true, name: true, role: true, active: true } as const;
export type Actor = { id: string; email: string; name: string; role: Role; active: boolean };

const denialMessage = "账号、密码或验证码不正确。";

async function limitLogin(email: string) {
  const time = new Date();
  const expiresAt = new Date(+time + 10 * 60_000);
  const key = digest("login:" + email);
  const rows = await db().$queryRaw<{ count: number }[]>`
    INSERT INTO "LoginLimit" ("key", "count", "expiresAt") VALUES (${key}, 1, ${expiresAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "LoginLimit"."expiresAt" <= ${time} THEN 1 ELSE "LoginLimit"."count" + 1 END,
      "expiresAt" = CASE WHEN "LoginLimit"."expiresAt" <= ${time} THEN ${expiresAt} ELSE "LoginLimit"."expiresAt" END
    RETURNING "count"`;
  if (rows[0].count > 8) throw new AppError("登录尝试过多，请稍后再试。", 429);
  return key;
}

export async function signIn(input: unknown) {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) throw new AppError(denialMessage, 401);
  const { email, password, code } = parsed.data;
  const limitKey = await limitLogin(email);
  const user = await db().user.findUnique({ where: { email } });
  const passwordOk = await checkPassword(password, user?.passwordHash);
  if (!user?.active || !passwordOk) throw new AppError(denialMessage, 401);
  const step = validTotpStep(email, decrypt(user.totpSecret, "totp:" + user.id), code);
  if (step === null) throw new AppError(denialMessage, 401);

  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionLifetime);
  await db().$transaction(async tx => {
    const claimed = await tx.user.updateMany({
      where: { id: user.id, active: true, passwordHash: user.passwordHash, totpSecret: user.totpSecret,
        OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
      data: { lastTotpStep: step },
    });
    if (claimed.count !== 1) throw new AppError(denialMessage, 401);
    await tx.session.create({ data: { digest: digest(raw), userId: user.id, expiresAt } });
    await tx.loginLimit.deleteMany({ where: { key: limitKey } });
    await audit(tx, user.id, "session.sign_in", user.id);
  });

  const jar = await cookies();
  jar.set(sessionCookie, raw, {
    httpOnly: true, sameSite: "lax", secure: (process.env.APP_URL ?? "").startsWith("https://"),
    path: "/", expires: expiresAt,
  });
}

export async function currentActor(): Promise<Actor | null> {
  const raw = (await cookies()).get(sessionCookie)?.value;
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const row = await db().session.findUnique({
    where: { digest: digest(raw) }, select: { user: { select: publicUser }, expiresAt: true },
  });
  return row?.user.active && row.expiresAt > new Date() ? row.user : null;
}

export async function requireActor(...allowed: Role[]): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) throw new AppError("请先登录。", 401);
  if (allowed.length && !allowed.includes(actor.role)) throw new AppError("没有执行此操作的权限。", 403);
  return actor;
}

export async function pageActor(...allowed: Role[]): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  if (allowed.length && !allowed.includes(actor.role)) redirect("/");
  return actor;
}

export async function signOut() {
  const jar = await cookies();
  const raw = jar.get(sessionCookie)?.value;
  if (raw) await db().session.deleteMany({ where: { digest: digest(raw) } });
  jar.delete(sessionCookie);
}
