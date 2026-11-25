import "dotenv/config";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { db } from "@/server/db";
import { wakeAssetMaintenance } from "@/server/assets/service";
import { dispatchableStatuses, runTask } from "./task";
import { refreshExpiringAccounts } from "./refresh";

const redis = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:56379");
if (!["redis:", "rediss:"].includes(redis.protocol)) throw new Error("REDIS_URL 通讯协议无效");
const producer = new Redis(redis.href, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
const consumer = new Redis(redis.href, { maxRetriesPerRequest: null });
const queueName = "publisher-delivery";
const queue = new Queue<{ taskId: string }>(queueName, { connection: producer, defaultJobOptions: {
  removeOnComplete: true, removeOnFail: true,
} });
const worker = new Worker<{ taskId: string }>(queueName, job => runTask(job.data.taskId), {
  connection: consumer, concurrency: 6, lockDuration: 120_000,
});
const lastMessage = new Map<string, number>();
function report(message: string) {
  const now = Date.now();
  if (now - (lastMessage.get(message) ?? 0) < 30_000) return;
  lastMessage.set(message, now);
  console.error(message);
}
const reportConnection = () => report("任务队列暂时不可用。");
producer.on("error", reportConnection);
consumer.on("error", reportConnection);
queue.on("error", reportConnection);
worker.on("error", reportConnection);
worker.on("failed", () => report("工作任务中断，将由数据库状态恢复。"));

let dispatching = false;
async function dispatch() {
  if (dispatching) return;
  dispatching = true;
  try {
    const now = new Date();
    const tasks = await db().publishTask.findMany({
      where: { status: { in: dispatchableStatuses }, nextRunAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
      select: { id: true, attempt: true, nextRunAt: true }, take: 200, orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
    });
    if (tasks.length) await queue.addBulk(tasks.map(task => ({
      name: "deliver", data: { taskId: task.id },
      opts: { jobId: `${task.id}-${task.attempt}-${task.nextRunAt?.getTime()}` },
    })));
  } catch {
    report("扫描待发布任务失败，稍后重试。");
  } finally {
    dispatching = false;
  }
}

let maintaining = false;
async function maintain() {
  if (maintaining) return;
  maintaining = true;
  try {
    await Promise.allSettled([
      wakeAssetMaintenance(), refreshExpiringAccounts(),
      db().oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
      db().session.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
      db().loginLimit.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    ]);
  } finally { maintaining = false; }
}

const scan = setInterval(() => void dispatch(), 1000);
const maintenance = setInterval(() => void maintain(), 15_000);
void dispatch();
void maintain();

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(scan);
  clearInterval(maintenance);
  await worker.close();
  await queue.close();
  producer.disconnect();
  consumer.disconnect();
  await db().$disconnect();
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
console.info("一键发布队列已启动。");
