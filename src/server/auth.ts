import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Role } from "@/generated/prisma/enums";
import { audit } from "./audit";
import { checkPassword, decrypt, digest } from "./crypto";
import { db } from "./db";
import { AppError } from "./errors";
import { consumeRateLimit, withLoginPasswordSlot } from "./rate-limit";
import { validTotpStep } from "./totp";

const sessionCookie = "publisher_session";
const sessionLifetime = 8 * 60 * 60 * 1000;
const passwordChangeLifetime = 10 * 60 * 1000;
export const temporaryPasswordPath = "/change-temporary-password";
const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  password: z.string().min(1).max(128),
  code: z.string().regex(/^\d{6}$/),
});
const publicUser = { id: true, email: true, name: true, role: true, active: true } as const;
export type Actor = { id: string; email: string; name: string; role: Role; active: boolean };

const denialMessage = "账号、密码或验证码不正确。";

export async function signIn(input: unknown, address?: string) {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) throw new AppError(denialMessage, 401);
  const { email, password, code } = parsed.data;
  const limitKey = address ? await consumeRateLimit(`login:account-address:${email}:${address}`, 8) : undefined;
  async function deny(): Promise<never> {
    // Without a trusted source, a failed-password bucket must never block a valid sign-in.
    if (!address) await consumeRateLimit("login:denied:" + email, 8);
    throw new AppError(denialMessage, 401);
  }
  const { user, passwordOk } = await withLoginPasswordSlot(async () => {
    const user = await db().user.findUnique({ where: { email } });
    return { user, passwordOk: await checkPassword(password, user?.passwordHash) };
  });
  if (!user?.active || !passwordOk) return deny();
  const secondFactorKey = await consumeRateLimit("login:totp:" + user.id, 8);
  const step = validTotpStep(email, decrypt(user.totpSecret, "totp:" + user.id), code);
  if (step === null) return deny();

  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (user.mustChangePassword ? passwordChangeLifetime : sessionLifetime));
  await db().$transaction(async tx => {
    const claimed = await tx.user.updateMany({
      where: { id: user.id, active: true, passwordHash: user.passwordHash, totpSecret: user.totpSecret,
        mustChangePassword: user.mustChangePassword,
        OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
      data: { lastTotpStep: step },
    });
    if (claimed.count !== 1) throw new AppError(denialMessage, 401);
    await tx.session.create({
      data: { digest: digest(raw), userId: user.id, expiresAt, passwordChangeOnly: user.mustChangePassword },
    });
    await tx.loginLimit.deleteMany({ where: { key: { in: limitKey ? [limitKey, secondFactorKey] : [secondFactorKey] } } });
    await audit(tx, user.id, "session.sign_in", user.id);
  });

  const jar = await cookies();
  jar.set(sessionCookie, raw, {
    httpOnly: true, sameSite: "lax", secure: (process.env.APP_URL ?? "").startsWith("https://"),
    path: "/", expires: expiresAt,
  });
}

export async function currentSessionDigest() {
  const raw = (await cookies()).get(sessionCookie)?.value;
  return raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? digest(raw) : null;
}

export async function currentSession() {
  const key = await currentSessionDigest();
  if (!key) return null;
  const row = await db().session.findUnique({
    where: { digest: key },
    select: { user: { select: { ...publicUser, mustChangePassword: true } }, expiresAt: true, passwordChangeOnly: true },
  });
  if (!row?.user.active || row.expiresAt <= new Date()) return null;
  const { mustChangePassword, ...actor } = row.user;
  if (mustChangePassword !== row.passwordChangeOnly) return null;
  return { actor, passwordChangeOnly: row.passwordChangeOnly };
}

export async function requireActor(...allowed: Role[]): Promise<Actor> {
  const session = await currentSession();
  if (!session) throw new AppError("请先登录。", 401);
  if (session.passwordChangeOnly) throw new AppError("请先修改临时密码。", 403);
  const { actor } = session;
  if (allowed.length && !allowed.includes(actor.role)) throw new AppError("没有执行此操作的权限。", 403);
  return actor;
}

export async function pageActor(...allowed: Role[]): Promise<Actor> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.passwordChangeOnly) redirect(temporaryPasswordPath);
  const { actor } = session;
  if (allowed.length && !allowed.includes(actor.role)) redirect("/");
  return actor;
}

export async function signOut() {
  const jar = await cookies();
  const raw = jar.get(sessionCookie)?.value;
  if (raw) await db().session.deleteMany({ where: { digest: digest(raw) } });
  jar.delete(sessionCookie);
}
