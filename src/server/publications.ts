import { Prisma } from "@/generated/prisma/client";
import type { AccountMode, TaskStatus } from "@/generated/prisma/enums";
import { draftSchema, resolveDraftCopy } from "@/lib/draft-schema";
import { formatBody, validatePublication } from "@/lib/publication";
import { isPlatform, platformRules, type Language, type PlatformKey } from "@/lib/platforms";
import type { PublishPayload } from "@/platforms/types";
import { liveAvailability } from "@/platforms/registry";
import { audit } from "./audit";
import type { Actor } from "./auth";
import { db, type Transaction } from "./db";
import { AppError } from "./errors";
import { notify } from "./notices";

const editable = ["DRAFT", "RETURNED"] as const;
const tasksForView = {
  id: true, mode: true, platform: true, status: true, runAt: true, language: true,
  postUrl: true, externalId: true, publishedAt: true, errorCode: true, errorMessage: true, retryCount: true,
  account: { select: { name: true, backendUrl: true } },
} as const;

type PlanRow = {
  accountId: string;
  accountName: string;
  platform: PlatformKey | null;
  language: Language;
  mode: AccountMode;
  payload: PublishPayload | null;
  runAt: string | null;
  errors: string[];
  warnings: string[];
};

async function buildPlan(client: Transaction, id: string, ownerId: string) {
  const content = await client.content.findFirst({
    where: { id, ownerId, status: { in: [...editable] } },
    include: { assets: { include: { asset: true } } },
  });
  if (!content) throw new AppError("找不到可提交的草稿。", 404);

  const draft = draftSchema.parse({ versions: content.versions, overrides: content.overrides, selections: content.selections });
  const ids = draft.selections.map(selection => selection.accountId);
  const [accounts, preference] = await Promise.all([
    client.platformAccount.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, language: true, platform: true, mode: true, status: true, expiresAt: true },
    }),
    client.preference.findUnique({ where: { id: "workspace" }, select: { reviewRequired: true } }),
  ]);
  const byAccount = new Map(accounts.map(account => [account.id, account]));
  const material = new Map(content.assets.map(({ asset }) => [asset.id, asset]));
  const now = Date.now();

  const rows: PlanRow[] = draft.selections.map(selection => {
    const account = byAccount.get(selection.accountId);
    const key = account && isPlatform(account.platform) ? account.platform : null;
    const mode = account?.mode ?? "MOCK";
    const language = selection.language ?? account?.language ?? "ZH";
    const row: PlanRow = {
      accountId: selection.accountId, accountName: account?.name ?? "账号不可用", platform: key, mode, language,
      payload: null, runAt: selection.runAt ?? null, errors: [], warnings: [],
    };
    if (!key || !account) {
      row.errors.push("平台账号不存在。");
      return row;
    }
    if (account.status !== "ACTIVE" || (account.expiresAt && +account.expiresAt <= now)) row.errors.push("账号未绑定或授权已到期。");
    if (mode === "LIVE") {
      const availability = liveAvailability(key);
      if (!availability.available) row.errors.push(availability.reason ?? "真实发布尚不可用。");
    }
    if (selection.runAt && Date.parse(selection.runAt) < now - 60_000) row.errors.push("定时发布时间已过，请重新选择。");
    const copy = resolveDraftCopy(draft, key, language);
    if (!copy) {
      row.errors.push("未填写此账号指定的语言版本。");
      return row;
    }
    const options: PublishPayload["options"] = {};
    for (const option of platformRules[key].options ?? []) {
      const value = selection.options?.[option.key] ?? option.default;
      if (value !== undefined && value !== "") options[option.key] = value;
    }
    row.payload = { ...copy, body: formatBody(key, copy), language, options };
    const files = copy.assetIds.flatMap(assetId => {
      const asset = material.get(assetId);
      return asset ? [asset] : [];
    });
    const checked = validatePublication(key, row.payload, files, copy.coverId ? material.get(copy.coverId) : undefined);
    row.errors.push(...checked.errors);
    row.warnings.push(...checked.warnings);
    return row;
  });

  const duplicates = new Map<string, PlanRow[]>();
  for (const row of rows) {
    if (!row.platform || !row.payload || row.errors.length || !platformRules[row.platform].distinctTargets) continue;
    const fingerprint = JSON.stringify([row.platform, row.payload.body.normalize("NFKC").trim().replace(/\s+/g, " "),
      [...row.payload.assetIds].sort()]);
    const found = duplicates.get(fingerprint) ?? [];
    found.push(row);
    duplicates.set(fingerprint, found);
  }
  for (const group of duplicates.values()) {
    if (group.length > 1) group.forEach(row => row.errors.push("同一平台的多个账号不可提交相同文案和素材。"));
  }

  return {
    id: content.id,
    title: draft.versions.ZH.title || "未命名草稿",
    revision: content.revision,
    contentStatus: content.status,
    reviewRequired: preference?.reviewRequired ?? false,
    rows,
    draft,
  };
}

export function publicationPlan(actor: Actor, id: string) {
  return buildPlan(db(), id, actor.id);
}

export async function submitPublication(actor: Actor, id: string, revision: number, skipInvalid: boolean) {
  try {
    return await db().$transaction(async tx => {
      const plan = await buildPlan(tx, id, actor.id);
      if (plan.revision !== revision) throw new AppError("草稿已更新，请重新核对发布清单。", 409);
      const ready = plan.rows.filter(row => !row.errors.length && row.platform && row.payload);
      if (!ready.length) throw new AppError("没有可提交的账号。", 422);
      if (ready.length < plan.rows.length && !skipInvalid) throw new AppError("请修改有问题的账号，或确认仅提交已通过校验的账号。", 422);

      const now = new Date();
      const result = await tx.content.updateMany({
        where: { id, ownerId: actor.id, revision, status: { in: [...editable] } },
        data: { status: plan.reviewRequired ? "IN_REVIEW" : "SUBMITTED",
          submittedAt: now, revision: { increment: 1 }, reviewNote: null },
      });
      if (result.count !== 1) throw new AppError("草稿已被修改或提交。", 409);
      for (const row of ready) {
        const runAt = row.runAt && +new Date(row.runAt) > +now ? new Date(row.runAt) : now;
        const status: TaskStatus = plan.reviewRequired ? "WAITING_APPROVAL" : runAt > now ? "SCHEDULED" : "QUEUED";
        const delivery = { mode: row.mode, platform: row.platform!, language: row.language,
          payload: row.payload! satisfies Prisma.InputJsonValue, status, runAt, nextRunAt: plan.reviewRequired ? null : runAt };
        const previous = plan.contentStatus === "RETURNED" ? await tx.publishTask.findUnique({
          where: { contentId_accountId: { contentId: id, accountId: row.accountId } },
          select: { id: true, status: true, externalId: true, providerState: true, publishedAt: true, leaseToken: true },
        }) : null;
        if (previous && (previous.status !== "CANCELLED" || previous.externalId || previous.providerState || previous.publishedAt || previous.leaseToken)) {
          throw new AppError("该账号已有不可重复提交的任务。", 409);
        }
        const task = previous ? await tx.publishTask.update({
          where: { id: previous.id }, data: { ...delivery, errorCode: null, errorMessage: null,
            attempt: { increment: 1 }, retryCount: 0 },
          select: { id: true },
        }) : await tx.publishTask.create({
          data: { ...delivery, contentId: id, accountId: row.accountId, publisherId: actor.id }, select: { id: true },
        });
        await audit(tx, actor.id, previous ? "publish.task_resubmitted" : "publish.task_created", task.id,
          { contentId: id, accountId: row.accountId, platform: row.platform!, status });
      }
      if (plan.reviewRequired) {
        const reviewers = await tx.user.findMany({ where: { role: "REVIEWER", active: true }, select: { id: true } });
        await notify(tx, reviewers.map(user => user.id), "review_waiting", `待审核内容 · ${plan.title}`, `submit:${id}:${revision}`, "/review");
      }
      await audit(tx, actor.id, plan.reviewRequired ? "publish.request_review" : "publish.submit", id, { taskCount: ready.length });
      return id;
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002")) {
      throw new AppError("内容已被更新，请核对发布状态。", 409);
    }
    throw error;
  }
}

export async function publicationProgress(actor: Actor, id: string) {
  const canSeeAll = actor.role === "ADMIN";
  const content = await db().content.findFirst({
    where: { id, ...(canSeeAll ? {} : { ownerId: actor.id }), status: { in: ["IN_REVIEW", "SUBMITTED", "RETURNED"] } },
    select: { id: true, ownerId: true, status: true, versions: true, submittedAt: true, reviewNote: true,
      tasks: { select: tasksForView, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
  if (!content) throw new AppError("找不到发布记录。", 404);
  return {
    id: content.id,
    title: draftSchema.shape.versions.safeParse(content.versions).data?.ZH.title || "未命名内容",
    status: content.status, canManage: content.ownerId === actor.id, reviewNote: content.reviewNote, submittedAt: content.submittedAt?.toISOString() ?? null,
    tasks: content.tasks.map(row => ({
      ...row, runAt: row.runAt.toISOString(), publishedAt: row.publishedAt?.toISOString() ?? null,
    })),
  };
}

export async function retryTask(actor: Actor, id: string) {
  await db().$transaction(async tx => {
    const task = await tx.publishTask.findFirst({ where: { id, publisherId: actor.id },
      select: { id: true, status: true, account: { select: { status: true, expiresAt: true } } } });
    if (!task) throw new AppError("找不到该任务。", 404);
    if (task.status !== "FAILED") throw new AppError("只有确认未发布或被平台拒绝的失败任务可重试。", 409);
    if (task.account.status !== "ACTIVE" || (task.account.expiresAt && +task.account.expiresAt <= Date.now())) {
      throw new AppError("账号授权不可用，请联系管理员。", 422);
    }
    const changed = await tx.publishTask.updateMany({ where: { id, status: "FAILED" },
      data: { status: "QUEUED", nextRunAt: new Date(), attempt: { increment: 1 }, retryCount: 0,
        errorCode: null, errorMessage: null, leaseToken: null, leaseExpiresAt: null, providerState: null, externalId: null } });
    if (!changed.count) throw new AppError("任务状态刚刚发生变化。", 409);
    await audit(tx, actor.id, "publish.retry", id);
  });
}
