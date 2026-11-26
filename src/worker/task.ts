import { randomUUID } from "node:crypto";
import type { AccountStatus, TaskStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { isPlatform, platformRules } from "@/lib/platforms";
import { adapterFor, liveAvailability } from "@/platforms/registry";
import { ProviderError, type AdapterContext, type ProviderState, type PublishOutcome, type PublishPayload, type StatusOutcome } from "@/platforms/types";
import { accountCredentials } from "@/server/account-secrets";
import { audit } from "@/server/audit";
import { decrypt, encrypt } from "@/server/crypto";
import { db, type Transaction } from "@/server/db";
import { errorDetails, logError, withLogContext } from "@/server/logging";
import { notify } from "@/server/notices";
import { providerMedia } from "@/server/provider-media";
import { lockPublisher } from "@/server/publisher-access";
import { publisherDisabled } from "@/server/schedules";

const leaseMs = 90_000;
const pollingWindow = 24 * 60 * 60 * 1000;
const maximumRetries = 3;
export const dispatchableStatuses: TaskStatus[] = ["SCHEDULED", "QUEUED", "UPLOADING", "PUBLISHING", "PROCESSING"];

type Envelope = {
  data: ProviderState;
  uploaded: boolean;
  submitted: boolean;
  pollFrom?: number;
};

class LeaseLost extends Error {}
class PublisherDisabled extends Error {}

export function runTask(id: string) {
  const logContext: { taskId: string; platform?: string } = { taskId: id };
  return withLogContext(logContext, () => runLoggedTask(id, logContext));
}

async function runLoggedTask(id: string, logContext: { platform?: string }) {
  const time = new Date();
  const token = randomUUID();
  const claim = await db().publishTask.updateMany({
    where: {
      id, status: { in: dispatchableStatuses }, nextRunAt: { lte: time },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: time } }],
    },
    data: { leaseToken: token, leaseExpiresAt: new Date(+time + leaseMs) },
  });
  if (!claim.count) return;

  const task = await db().publishTask.findUnique({
    where: { id, leaseToken: token }, include: { account: true, publisher: { select: { active: true } } },
  });
  if (!task) return;
  logContext.platform = task.platform;
  const label = isPlatform(task.platform) ? platformRules[task.platform].label : "平台";
  const phase = task.status;
  const attempt = task.attempt;
  let externalId = task.externalId ?? undefined;
  let state: Envelope = { data: {}, uploaded: false, submitted: false };
  let lost = false;
  let querying = Boolean(externalId) || phase === "PROCESSING";
  const pulse = setInterval(() => {
    void db().publishTask.updateMany({
      where: { id, leaseToken: token }, data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
    }).then(result => { if (!result.count) lost = true; }).catch(() => { lost = true; });
  }, leaseMs / 3);
  pulse.unref();

  async function progress(status: TaskStatus, data: Prisma.PublishTaskUpdateManyMutationInput = {}, release = false) {
    if (lost) throw new LeaseLost();
    await db().$transaction(async tx => {
      const requiresActivePublisher = status === "MANUAL" || (status === "SUCCESS" && task!.mode === "MOCK");
      if (requiresActivePublisher && !(await lockPublisher(tx, task!.publisherId))?.active) throw new PublisherDisabled();
      const updated = await tx.publishTask.updateMany({
        where: { id, leaseToken: token, attempt },
        data: { ...data, status, ...(release ? { leaseExpiresAt: null, leaseToken: null } : {}) },
      });
      if (!updated.count) throw new LeaseLost();
      await audit(tx, null, "publish.status." + status.toLowerCase(), id, {
        contentId: task!.contentId, platform: task!.platform, accountId: task!.accountId,
        ...(typeof data.errorCode === "string" ? { errorCode: data.errorCode } : {}),
      });
      if (["SUCCESS", "FAILED", "UNKNOWN", "MANUAL"].includes(status)) {
        const message = status === "SUCCESS" ? (task!.mode === "MOCK" ? "模拟发布完成" : "发布成功") :
          status === "FAILED" ? "发布失败" : status === "MANUAL" ? "待人工发布" : "发布结果待核对";
        await notify(tx, [task!.publisherId], status.toLowerCase(), `${label} · ${message}`,
          `task:${id}:${attempt}:${status}`, `/contents/${task!.contentId}/progress`);
      }
    });
  }

  async function checkpoint(extra: Prisma.PublishTaskUpdateManyMutationInput = {}, client: Transaction = db(), savedState = state) {
    if (lost) throw new LeaseLost();
    const saved = await client.publishTask.updateMany({ where: { id, leaseToken: token, attempt },
      data: { ...extra, providerState: encrypt(JSON.stringify(savedState), "publish-task:" + id) } });
    if (!saved.count) throw new LeaseLost();
  }

  async function finish(outcome: PublishOutcome, next: "UPLOADING" | "PROCESSING" = "PROCESSING") {
    if (outcome.kind === "success") {
      await progress("SUCCESS", { externalId: outcome.externalId, postUrl: outcome.url ?? null, publishedAt: new Date(),
        nextRunAt: null, providerState: null, errorCode: outcome.warning ? "published_with_warning" : null, errorMessage: outcome.warning ?? null }, true);
      return;
    }
    if (outcome.kind === "manual") {
      await progress("MANUAL", { nextRunAt: null, providerState: null }, true);
      return;
    }
    externalId = outcome.externalId ?? externalId;
    const delay = Math.max(1000, Math.min(outcome.pollInMs ?? 5000, 10 * 60_000));
    state.pollFrom ??= Date.now();
    if (Date.now() - state.pollFrom > pollingWindow) {
      await progress("UNKNOWN", { externalId, nextRunAt: null, errorCode: "status_timeout",
        errorMessage: "平台超过 24 小时未返回最终结果。请在官方后台核对。" }, true);
      return;
    }
    await progress(next, { externalId, providerState: encrypt(JSON.stringify(state), "publish-task:" + id),
      nextRunAt: new Date(Date.now() + delay), retryCount: 0 }, true);
  }

  try {
    if (task.providerState) {
      try {
        state = JSON.parse(decrypt(task.providerState, "publish-task:" + id)) as Envelope;
        if (typeof state.submitted !== "boolean" || typeof state.uploaded !== "boolean" || !state.data) throw new Error("Invalid checkpoint");
      } catch (error) {
        logError("worker.checkpoint_unreadable", { attempt, error: errorDetails(error) });
        querying ||= phase === "PUBLISHING";
        throw new ProviderError("checkpoint_unreadable", "历史发布状态无法读取，需要在官方后台核对。", { definite: true });
      }
    }
    querying ||= state.submitted;
    if (!querying && !task.publisher.active) throw new PublisherDisabled();
    if (!isPlatform(task.platform)) throw new ProviderError("invalid_platform", "发布平台不存在。", { definite: true });
    const availability = task.mode === "LIVE" ? liveAvailability(task.platform) : { available: true };
    if (!availability.available) throw new ProviderError("unavailable", "真实发布接入尚不可用。", { definite: true });
    const accountUnavailable = task.account.status !== "ACTIVE" ||
      (task.account.expiresAt && +task.account.expiresAt <= Date.now()) || task.mode !== task.account.mode;
    if (accountUnavailable) throw new ProviderError("account_disabled", "账号未绑定或授权已过期。", { definite: true });
    const adapter = adapterFor(task.platform, task.mode);
    const payload = task.payload as unknown as PublishPayload;
    const credentials = task.mode === "LIVE" && task.account.credential
      ? accountCredentials(task.accountId, task.account.credential)
      : { externalId: task.account.externalId, accountName: task.account.name, accessToken: "" };
    if (task.mode === "LIVE" && !credentials.accessToken) {
      throw new ProviderError("credentials_missing", "没有可用的账号授权。", { reauth: true, definite: true });
    }
    const media = task.mode === "LIVE" ? await Promise.all(payload.assetIds.map(providerMedia)) : [];
    const cover = task.mode === "LIVE" && payload.coverId ? await providerMedia(payload.coverId) : undefined;
    const context: AdapterContext = {
      taskId: id, createdAt: task.createdAt, media, cover, payload, credentials, state: state.data, externalId,
      checkpoint: async value => { state.data = value; context.state = value; await checkpoint(); },
      beginSubmission: async () => {
        // Serialize the durable submission checkpoint with disabling the publisher.
        await db().$transaction(async tx => {
          if (!(await lockPublisher(tx, task.publisherId))?.active) throw new PublisherDisabled();
          const permitted = await tx.platformAccount.findFirst({
            where: { id: task.accountId, status: "ACTIVE", mode: task.mode, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
            select: { id: true },
          });
          if (!permitted) throw new ProviderError("account_disabled", "账号授权在发布前已失效。", { definite: true });
          await checkpoint({ status: "PUBLISHING" }, tx, { ...state, submitted: true });
        });
        state.submitted = true;
      },
    };

    if (querying) {
      const result: StatusOutcome = await adapter.queryStatus(context);
      querying = false;
      if (result.kind === "unknown") {
        await progress("UNKNOWN", { nextRunAt: null, errorCode: "no_confirmation",
          errorMessage: "平台未能确认是否发布。请在官方后台核对，系统会保留任务以防重复发布。" }, true);
        return;
      }
      if (result.kind !== "safe-to-resume") {
        await finish(result);
        return;
      }
      state.submitted = false;
      state.pollFrom = undefined;
      if (!task.publisher.active) throw new PublisherDisabled();
      await checkpoint();
    }

    if (!state.uploaded) {
      await progress("UPLOADING");
      await adapter.validate?.(context);
      const upload = await adapter.uploadMedia(context);
      if (upload.kind === "pending") {
        await finish({ kind: "pending", pollInMs: upload.pollInMs }, "UPLOADING");
        return;
      }
      state.uploaded = true;
      state.pollFrom = undefined;
      await checkpoint();
    }

    await progress("PUBLISHING");
    const result = await adapter.publish(context);
    await finish(result);
  } catch (error) {
    if (error instanceof LeaseLost) return;
    if (error instanceof PublisherDisabled) {
      try {
        await progress("CANCELLED", { nextRunAt: null, providerState: null, ...publisherDisabled }, true);
      } catch (failure) {
        if (!(failure instanceof LeaseLost)) throw failure;
      }
      return;
    }
    if (!(error instanceof ProviderError)) {
      logError("worker.task_failed", { attempt, phase, error: errorDetails(error) });
    }
    const provider = error instanceof ProviderError ? error :
      new ProviderError("internal_error", "任务暂时未能完成。", { retryable: true });
    if (provider.options.reauth) {
      const status: AccountStatus = "REAUTH_REQUIRED";
      await db().$transaction(async tx => {
        const changed = await tx.platformAccount.updateMany({
          where: { id: task.accountId, status: "ACTIVE" }, data: { status },
        });
        if (!changed.count) return;
        await audit(tx, null, "account.reauth_required", task.accountId);
      });
    }

    if (state.submitted && !provider.options.definite && !querying) {
      await progress("PROCESSING", { nextRunAt: new Date(Date.now() + 2000), errorCode: provider.code,
        errorMessage: "正在核对平台是否已收到发布。" }, true);
      return;
    }
    if (provider.options.retryable && task.retryCount < maximumRetries && (!state.submitted || querying || provider.options.definite)) {
      if (!querying && provider.options.definite) state.submitted = false;
      const next = querying ? "PROCESSING" : state.uploaded ? "PUBLISHING" : "UPLOADING";
      const retryDelay = Math.max(2000 * 2 ** task.retryCount, Math.min(provider.options.retryAfterMs ?? 0, 60 * 60_000));
      await progress(next, { retryCount: { increment: 1 }, nextRunAt: new Date(Date.now() + retryDelay),
        errorCode: provider.code, errorMessage: provider.message, providerState: encrypt(JSON.stringify(state), "publish-task:" + id) }, true);
      return;
    }
    const unclear = (state.submitted || querying || Boolean(externalId)) && (querying ? provider.code !== "post_rejected" && provider.code !== "moderation_rejected" : !provider.options.definite);
    await progress(unclear ? "UNKNOWN" : "FAILED", { nextRunAt: null, errorCode: provider.code, errorMessage: provider.message }, true);
  } finally {
    clearInterval(pulse);
  }
}
