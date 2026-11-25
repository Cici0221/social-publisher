import { randomBytes, randomUUID } from "node:crypto";
import type { AccountMode, Language } from "@/generated/prisma/enums";
import { platformRules, type PlatformKey } from "@/lib/platforms";
import { adapterFor, liveAvailability } from "@/platforms/registry";
import type { Credentials } from "@/platforms/types";
import { sealAccount } from "./account-secrets";
import { audit } from "./audit";
import type { Actor } from "./auth";
import { decrypt, digest, encrypt } from "./crypto";
import { db } from "./db";
import { AppError } from "./errors";

export const accountFields = {
  id: true, name: true, platform: true, mode: true, status: true, language: true,
  expiresAt: true, backendUrl: true, createdAt: true,
} as const;

export function accountList() {
  return db().platformAccount.findMany({ orderBy: [{ platform: "asc" }, { name: "asc" }], select: accountFields });
}

export function refreshTime(expiresAt: Date, now = Date.now()) {
  const remaining = Math.max(0, +expiresAt - now);
  return new Date(+expiresAt - Math.min(7 * 86_400_000, Math.max(60_000, remaining / 4)));
}

export async function saveDemoAccount(actor: Actor, key: PlatformKey, name: string, language: Language) {
  if (process.env.APP_MODE !== "local") throw new AppError("模拟账号只在本地演示环境可创建。", 403);
  if (platformRules[key].mode === "manual") throw new AppError("此平台使用人工登记。", 422);
  return db().$transaction(async tx => {
    const account = await tx.platformAccount.create({
      data: { platform: key, externalId: "mock-" + randomUUID(), language, name, mode: "MOCK" },
      select: accountFields,
    });
    await audit(tx, actor.id, "account.bind_mock", account.id, { platform: key });
    return account;
  });
}

async function saveBinding(actor: Actor, key: PlatformKey, credentials: Credentials[]) {
  if (!credentials.length) throw new AppError("该授权未返回可绑定的账号。", 422);
  return db().$transaction(async tx => {
    for (const access of credentials) {
      const mode: AccountMode = "LIVE";
      const existing = await tx.platformAccount.findUnique({
        where: { platform_externalId_mode: { platform: key, externalId: access.externalId, mode } },
        select: { id: true },
      });
      const id = existing?.id ?? randomUUID();
      const expiresAt = access.expiresAt ? new Date(access.expiresAt) : null;
      const data = { name: access.accountName, status: "ACTIVE" as const, credential: sealAccount(id, access), expiresAt,
        refreshAfter: expiresAt ? refreshTime(expiresAt) : null, refreshLease: null };
      if (existing) await tx.platformAccount.update({ where: { id }, data });
      else await tx.platformAccount.create({ data: { ...data, id, platform: key, externalId: access.externalId, mode } });
      await audit(tx, actor.id, existing ? "account.reauthorized" : "account.bound", id, { platform: key });
    }
  }, { isolationLevel: "Serializable" });
}

function callback(key: PlatformKey) {
  return new URL("/api/accounts/oauth/" + key, process.env.APP_URL ?? "http://localhost:3000").href;
}

export async function authorizeAccount(actor: Actor, key: PlatformKey) {
  const availability = liveAvailability(key);
  if (!availability.available) throw new AppError(availability.reason ?? "真实授权未启用。", 422);
  const adapter = adapterFor(key, "LIVE");
  if (adapter.bindFromEnvironment) {
    const credentials = await adapter.bindFromEnvironment();
    await saveBinding(actor, key, credentials);
    return null;
  }
  if (!adapter.authorize || !adapter.exchange) throw new AppError("此平台的真实授权尚不可用。", 422);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const keyHash = digest(state);
  const redirectUri = callback(key);
  const url = adapter.authorize({ state, redirectUri, verifier });
  await db().$transaction(async tx => {
    await tx.oAuthState.create({ data: { platform: key, digest: keyHash, userId: actor.id,
      verifier: encrypt(verifier, "oauth:" + keyHash), expiresAt: new Date(Date.now() + 10 * 60_000) } });
    await audit(tx, actor.id, "account.authorization_started", null, { platform: key });
  });
  return url;
}

export async function completeAuthorization(actor: Actor, key: PlatformKey, state: string, code: string) {
  if (!/^[a-zA-Z0-9_-]{43}$/.test(state) || !code || code.length > 4000) throw new AppError("授权请求无效。", 422);
  if (!liveAvailability(key).available) throw new AppError("真实授权尚不可用。", 422);
  const keyHash = digest(state);
  const adapter = adapterFor(key, "LIVE");
  if (!adapter.exchange) throw new AppError("授权方式无效。", 422);
  const claim = await db().$transaction(async tx => {
    const where = { digest: keyHash, userId: actor.id, platform: key, expiresAt: { gt: new Date() } };
    const entry = await tx.oAuthState.findFirst({ where });
    if (entry && (await tx.oAuthState.deleteMany({ where })).count === 1) return entry;
    return null;
  });
  if (!claim?.verifier) throw new AppError("授权已经处理或过期。", 422);
  const credentials = await adapter.exchange({ code, state, redirectUri: callback(key),
    verifier: decrypt(claim.verifier, "oauth:" + keyHash) });
  await saveBinding(actor, key, credentials);
}

export async function changeAccount(actor: Actor, id: string, data: { language?: Language; detach?: boolean }) {
  await db().$transaction(async tx => {
    const account = await tx.platformAccount.findUnique({ where: { id }, select: { status: true, language: true } });
    if (!account) throw new AppError("找不到平台账号。", 404);
    await tx.platformAccount.update({ where: { id }, data: {
      ...(data.language ? { language: data.language } : {}),
      ...(data.detach ? { status: "DISABLED", credential: null, expiresAt: null, refreshAfter: null, refreshLease: null } : {}),
    } });
    await audit(tx, actor.id, data.detach ? "account.unbound" : "account.preferences", id,
      data.language ? { from: account.language, to: data.language } : {});
  });
}
