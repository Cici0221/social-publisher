import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";

const globalDb = globalThis as { publisherDb?: PrismaClient };

export function db(): PrismaClient {
  if (globalDb.publisherDb) return globalDb.publisherDb;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL 未配置");
  globalDb.publisherDb = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return globalDb.publisherDb;
}

export type Transaction = Prisma.TransactionClient;
