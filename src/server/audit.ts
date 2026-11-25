import type { Prisma } from "@/generated/prisma/client";
import type { Transaction } from "./db";

export async function audit(
  client: Transaction,
  actorId: string | null,
  action: string,
  objectId: string | null,
  details: Prisma.InputJsonObject = {},
) {
  await client.auditLog.create({ data: { actorId, action, objectId, details } });
}
