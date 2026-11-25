import { isPlatform, platformRules } from "@/lib/platforms";
import { adapterFor, liveAvailability } from "@/platforms/registry";
import { ProviderError } from "@/platforms/types";
import { accountCredentials, sealAccount } from "@/server/account-secrets";
import { refreshTime } from "@/server/accounts";
import { audit } from "@/server/audit";
import { db } from "@/server/db";
import { notify } from "@/server/notices";

export async function refreshExpiringAccounts() {
  const time = new Date();
  const candidates = await db().platformAccount.findMany({
    where: { mode: "LIVE", status: "ACTIVE", refreshAfter: { lte: time }, OR: [{ refreshLease: null }, { refreshLease: { lt: time } }] },
    take: 12, orderBy: { refreshAfter: "asc" },
  });
  await Promise.allSettled(candidates.map(async account => {
    if (!account.credential || !isPlatform(account.platform)) return;
    const lease = new Date(Date.now() + 120_000);
    const locked = await db().platformAccount.updateMany({
      where: { id: account.id, credential: account.credential, status: "ACTIVE",
        OR: [{ refreshLease: null }, { refreshLease: { lt: time } }] },
      data: { refreshLease: lease },
    });
    if (!locked.count) return;
    const key = account.platform;
    const where = { id: account.id, refreshLease: lease, credential: account.credential };
    const expired = Boolean(account.expiresAt && +account.expiresAt <= +time);
    try {
      const adapter = adapterFor(key, "LIVE");
      const old = accountCredentials(account.id, account.credential);
      const next = liveAvailability(key).available && (!old.refreshExpiresAt || +new Date(old.refreshExpiresAt) > +time)
        ? await adapter.refresh(old) : null;
      if (next && next.externalId === old.externalId && (!next.expiresAt || +new Date(next.expiresAt) > +time)) {
        const expiresAt = next.expiresAt ? new Date(next.expiresAt) : null;
        await db().$transaction(async tx => {
          const changed = await tx.platformAccount.updateMany({ where, data: { credential: sealAccount(account.id, next),
            expiresAt, refreshAfter: expiresAt ? refreshTime(expiresAt) : null, refreshLease: null } });
          if (changed.count) await audit(tx, null, "account.renewed", account.id, { platform: key });
        });
        return;
      }
    } catch (error) {
      if (error instanceof ProviderError && error.options.retryable && !expired) {
        await db().platformAccount.updateMany({ where, data: { refreshLease: null, refreshAfter: new Date(+time + 5 * 60_000) } });
        return;
      }
    }
    await db().$transaction(async tx => {
      const changed = await tx.platformAccount.updateMany({ where, data: {
        status: expired ? "REAUTH_REQUIRED" : "ACTIVE", refreshLease: null,
        refreshAfter: expired ? null : account.expiresAt ?? new Date(+time + 86_400_000),
      } });
      if (!changed.count) return;
      await audit(tx, null, expired ? "account.expired" : "account.renewal_required", account.id, { platform: key });
      const admins = await tx.user.findMany({ where: { role: "ADMIN", active: true }, select: { id: true } });
      await notify(tx, admins.map(admin => admin.id), "account_expiring",
        `${platformRules[key].label} 的账号「${account.name}」${expired ? "授权已过期" : "授权即将过期"}，请重新授权。`,
        `account:${account.id}:${expired ? "expired" : "expiring"}:${account.expiresAt?.toISOString()}`, "/admin/accounts");
    });
  }));
}
