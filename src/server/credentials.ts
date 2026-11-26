import { randomBytes } from "node:crypto";
import { z } from "zod";
import { audit } from "./audit";
import { checkPassword, decrypt, digest, encrypt, hashPassword } from "./crypto";
import { db, type Transaction } from "./db";
import { AppError } from "./errors";
import { consumeRateLimit } from "./rate-limit";
import { enrollmentUri, newTotpSecret, validTotpStep } from "./totp";

const credentialFields = {
  id: true, email: true, active: true, role: true, passwordHash: true, mustChangePassword: true,
  totpSecret: true, lastTotpStep: true,
} as const;
const enrollmentLifetime = 10 * 60_000;
const enrollmentSchema = z.object({ expiresAt: z.number(), secret: z.string().regex(/^[A-Z2-7]{32}$/), version: z.string() });
export const newPasswordSchema = z.string().min(12).max(128);
const otp = z.string().regex(/^\d{6}$/);
export const credentialProofSchema = z.object({ password: z.string().min(1).max(128), code: otp });
export const passwordChangeSchema = credentialProofSchema.extend({ newPassword: newPasswordSchema });
export const totpChangeSchema = credentialProofSchema.extend({ challenge: z.string().min(1).max(512), newCode: otp });
export const credentialResetSchema = credentialProofSchema.extend({ factor: z.enum(["password", "totp"]) });
export const recoveryEmail = z.string().trim().email().max(254).toLowerCase();

type Proof = z.infer<typeof credentialProofSchema>;
type CredentialUser = NonNullable<Awaited<ReturnType<typeof findCredentialUser>>>;

const proofError = () => new AppError("当前密码或验证码无效。请使用最新且未用过的验证码。", 401);
const credentialConflict = () => new AppError("凭据或账号状态刚刚发生变化，请重新打开页面后再试。", 409);
const challengeError = () => new AppError("设置已过期或失效，请重新生成新密钥。", 400);
const passwordChangeSessionError = () => new AppError("修改临时密码的登录已失效，请重新登录。", 401);

function findCredentialUser(id: string) {
  return db().user.findUnique({ where: { id }, select: credentialFields });
}

async function verifyProof(user: CredentialUser, proof: Proof) {
  await consumeRateLimit(`credentials:${user.id}`, 8);
  if (!(await checkPassword(proof.password, user.passwordHash))) throw proofError();
  const step = validTotpStep(user.email, decrypt(user.totpSecret, `totp:${user.id}`), proof.code);
  if (step === null || (user.lastTotpStep !== null && step <= user.lastTotpStep)) throw proofError();
  return step;
}

function unchanged(user: CredentialUser) {
  return { id: user.id, active: true, role: user.role, passwordHash: user.passwordHash,
    totpSecret: user.totpSecret, mustChangePassword: user.mustChangePassword };
}

function unusedStep(step: bigint) {
  return { OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] };
}

async function revokeSessions(tx: Transaction, userId: string) {
  await tx.session.deleteMany({ where: { userId } });
  await tx.oAuthState.deleteMany({ where: { userId } });
}

async function activeCredentialUser(id: string) {
  const user = await findCredentialUser(id);
  if (!user?.active) throw new AppError("账号不可用。", 403);
  if (user.mustChangePassword) throw new AppError("请先修改临时密码。", 403);
  return user;
}

export async function changePassword(actorId: string, input: z.infer<typeof passwordChangeSchema>) {
  if (input.password === input.newPassword) throw new AppError("新密码与当前密码相同。", 400);
  const user = await activeCredentialUser(actorId);
  const step = await verifyProof(user, input);
  const passwordHash = await hashPassword(input.newPassword);
  await db().$transaction(async tx => {
    const changed = await tx.user.updateMany({ where: { ...unchanged(user), ...unusedStep(step) },
      data: { passwordHash, lastTotpStep: step } });
    if (changed.count !== 1) throw proofError();
    await revokeSessions(tx, actorId);
    await audit(tx, actorId, "credentials.password.change", actorId);
  });
}

export async function changeTemporaryPassword(digest: string | null, newPassword: string) {
  if (!digest) throw passwordChangeSessionError();
  const restricted = { digest, passwordChangeOnly: true };
  const user = await db().user.findFirst({
    where: { active: true, mustChangePassword: true, sessions: { some: { ...restricted, expiresAt: { gt: new Date() } } } },
    select: credentialFields,
  });
  if (!user) throw passwordChangeSessionError();
  await consumeRateLimit(`credentials:temporary-password:${user.id}`, 8);
  if (await checkPassword(newPassword, user.passwordHash)) throw new AppError("新密码须与临时密码不同。");

  const passwordHash = await hashPassword(newPassword);
  await db().$transaction(async tx => {
    const changed = await tx.user.updateMany({
      where: unchanged(user), data: { passwordHash, mustChangePassword: false },
    });
    if (changed.count !== 1) throw passwordChangeSessionError();
    const consumed = await tx.session.deleteMany({
      where: { ...restricted, userId: user.id, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) throw passwordChangeSessionError();
    await revokeSessions(tx, user.id);
    await audit(tx, user.id, "credentials.password.change", user.id, { temporary: true });
  });
}

type EnrollmentUser = Pick<CredentialUser, "id" | "email" | "passwordHash" | "totpSecret">;

function credentialVersion(user: EnrollmentUser) {
  return digest(JSON.stringify([user.passwordHash, user.totpSecret]));
}

export function createTotpChallenge(user: EnrollmentUser, now = Date.now()) {
  const secret = newTotpSecret();
  const value = { secret, expiresAt: now + enrollmentLifetime, version: credentialVersion(user) };
  const challenge = encrypt(JSON.stringify(value), `totp-enrollment:${user.id}`);
  return { challenge, secret, uri: enrollmentUri(user.email, secret) };
}

export function verifyTotpChallenge(user: EnrollmentUser, challenge: string, code: string, now = Date.now()) {
  let value: z.infer<typeof enrollmentSchema>;
  try {
    value = enrollmentSchema.parse(JSON.parse(decrypt(challenge, `totp-enrollment:${user.id}`)));
  } catch {
    throw challengeError();
  }
  if (now >= value.expiresAt || value.version !== credentialVersion(user)) throw challengeError();
  const step = validTotpStep(user.email, value.secret, code, now);
  if (step === null) throw new AppError("新验证器生成的验证码无效。", 400);
  return { secret: value.secret, step };
}

export async function startTotpChange(actorId: string) {
  return createTotpChallenge(await activeCredentialUser(actorId));
}

export async function changeTotp(actorId: string, input: z.infer<typeof totpChangeSchema>) {
  const user = await activeCredentialUser(actorId);
  const currentStep = await verifyProof(user, input);
  const setup = verifyTotpChallenge(user, input.challenge, input.newCode);
  const totpSecret = encrypt(setup.secret, `totp:${actorId}`);
  await db().$transaction(async tx => {
    const changed = await tx.user.updateMany({ where: { ...unchanged(user), ...unusedStep(currentStep) },
      data: { totpSecret, lastTotpStep: setup.step } });
    if (changed.count !== 1) throw proofError();
    await revokeSessions(tx, actorId);
    await audit(tx, actorId, "credentials.totp.change", actorId);
  });
}

function temporaryPassword() {
  return randomBytes(24).toString("base64url");
}

export async function resetMemberCredential(actorId: string, targetId: string, input: z.infer<typeof credentialResetSchema>) {
  if (actorId === targetId) throw new AppError("请在账号安全中修改自己的凭据。", 400);
  const actor = await activeCredentialUser(actorId);
  if (actor.role !== "ADMIN") throw new AppError("需要管理员权限。", 403);
  const step = await verifyProof(actor, input);
  const target = await findCredentialUser(targetId);
  if (!target?.active) throw new AppError("成员不存在或已停用。", 404);

  const replacement = input.factor === "password" ? temporaryPassword() : newTotpSecret();
  const data = input.factor === "password"
    ? { passwordHash: await hashPassword(replacement), mustChangePassword: true }
    : { totpSecret: encrypt(replacement, `totp:${target.id}`), lastTotpStep: null };

  await db().$transaction(async tx => {
    const claimed = await tx.user.updateMany({ where: { ...unchanged(actor), ...unusedStep(step) }, data: { lastTotpStep: step } });
    if (claimed.count !== 1) throw proofError();
    const changed = await tx.user.updateMany({ where: unchanged(target), data });
    if (changed.count !== 1) throw credentialConflict();
    await revokeSessions(tx, target.id);
    await audit(tx, actorId, `credentials.${input.factor}.reset`, target.id);
  });

  return input.factor === "password"
    ? { factor: "password" as const, password: replacement }
    : { factor: "totp" as const, secret: replacement, uri: enrollmentUri(target.email, replacement) };
}

export async function recoverAdministrator(email: string) {
  const user = await db().user.findUnique({ where: { email }, select: credentialFields });
  if (user?.role !== "ADMIN" || !user.active) throw new AppError("该邮箱没有对应的在职管理员。", 404);
  const password = temporaryPassword();
  const secret = newTotpSecret();
  const passwordHash = await hashPassword(password);
  await db().$transaction(async tx => {
    const changed = await tx.user.updateMany({ where: unchanged(user), data: {
      passwordHash, totpSecret: encrypt(secret, `totp:${user.id}`), lastTotpStep: null, mustChangePassword: true,
    } });
    if (changed.count !== 1) throw credentialConflict();
    await revokeSessions(tx, user.id);
    await audit(tx, null, "credentials.admin.recover", user.id);
  });
  return { password, secret };
}
