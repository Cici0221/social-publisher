import { isIP } from "node:net";
import { digest } from "./crypto";
import { db } from "./db";
import { AppError } from "./errors";
import { loginProxyHeader } from "./runtime-config";

let passwordChecks = 0;
const maxPasswordChecks = 2;

export function loginClientAddress(headers: Headers, trustedHeader = loginProxyHeader()) {
  if (!trustedHeader) return undefined;
  const address = headers.get(trustedHeader)?.trim();
  if (address && isIP(address) === 4) return address;
  const ipv6 = address && isIP(address) === 6 ? URL.parse(`http://[${address}]`) : null;
  if (!ipv6) throw new AppError("无法确认登录请求的来源地址。");
  return ipv6.hostname;
}

export async function withLoginPasswordSlot<T>(verify: () => Promise<T>): Promise<T> {
  // Each scrypt verification uses about 128 MiB. Refuse excess work before starting it.
  if (passwordChecks >= maxPasswordChecks) throw new AppError("当前登录请求过多，请稍后重试。", 429);
  passwordChecks++;
  try { return await verify(); }
  finally { passwordChecks--; }
}

export async function consumeRateLimit(bucket: string, max: number) {
  const time = new Date();
  const expiresAt = new Date(+time + 10 * 60_000);
  const key = digest(bucket);
  const rows = await db().$queryRaw<{ count: number }[]>`
    INSERT INTO "LoginLimit" ("key", "count", "expiresAt") VALUES (${key}, 1, ${expiresAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "LoginLimit"."expiresAt" <= ${time} THEN 1 ELSE LEAST("LoginLimit"."count", ${max}) + 1 END,
      "expiresAt" = CASE WHEN "LoginLimit"."expiresAt" <= ${time} THEN ${expiresAt} ELSE "LoginLimit"."expiresAt" END
    RETURNING "count"`;
  if (rows[0].count > max) throw new AppError("尝试次数过多，请稍后再试。", 429);
  return key;
}
