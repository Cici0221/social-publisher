import type { Transaction } from "./db";

export async function notify(tx: Transaction, userIds: string[], kind: string, message: string, dedupeKey: string, href?: string) {
  const targets = [...new Set(userIds)];
  if (!targets.length) return;
  await tx.notification.createMany({
    data: targets.map(userId => ({ userId, kind, message, dedupeKey, href })),
    skipDuplicates: true,
  });
}
