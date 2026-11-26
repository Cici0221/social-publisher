import type { Actor } from "./auth";
import type { Transaction } from "./db";
import { AppError } from "./errors";
import { publisherScope } from "./history";

export async function managedTaskScope(tx: Transaction, actor: Actor) {
  const current = await lockPublisher(tx, actor.id);
  if (!current?.active || current.role !== actor.role) throw new AppError("没有管理发布任务的权限。", 403);
  return publisherScope(actor);
}

export async function lockPublisher(tx: Transaction, id: string) {
  const [publisher] = await tx.$queryRaw<{ active: boolean; role: Actor["role"] }[]>`
    SELECT "active", "role" FROM "User" WHERE "id" = ${id} FOR SHARE`;
  return publisher;
}
