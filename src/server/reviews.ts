import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { Role, TaskStatus } from "@/generated/prisma/enums";
import { draftSchema } from "@/lib/draft-schema";
import { isPlatform, platformRules } from "@/lib/platforms";
import { audit } from "./audit";
import type { Actor } from "./auth";
import { db, type Transaction } from "./db";
import { AppError } from "./errors";
import { notify } from "./notices";
import { lockPublisher } from "./publisher-access";

const workspace = "workspace";
const pageSize = 24;

export const reviewDecisionSchema = z.strictObject({
  revision: z.number().int().min(0).max(2_147_483_646),
  decision: z.enum(["approve", "return"]),
  note: z.string().trim().min(1).max(2000),
});
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const reviewSettingsSchema = z.strictObject({ required: z.boolean() });

const frozenCopy = z.object({
  title: z.string(), body: z.string(), tags: z.array(z.string()),
  assetIds: z.array(z.uuid()), coverId: z.uuid().nullable(),
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

function assertRole(actor: Actor, role: Role) {
  if (!actor.active || actor.role !== role) throw new AppError("没有执行此操作的权限。", 403);
}

async function requireRoleInTransaction(tx: Transaction, actorId: string, role: Role) {
  if (!await tx.user.findFirst({ where: { id: actorId, role, active: true }, select: { id: true } })) {
    throw new AppError("成员角色已变更，不能继续此操作。", 403);
  }
}

function reviewTitle(versions: Prisma.JsonValue) {
  return draftSchema.shape.versions.safeParse(versions).data?.ZH.title || "未命名内容";
}

function contentId(id: string) {
  if (!z.uuid().safeParse(id).success) throw new AppError("找不到待审核内容。", 404);
  return id;
}

export async function reviewSettings(actor: Actor) {
  assertRole(actor, "ADMIN");
  const [preference, reviewerCount, pendingCount] = await Promise.all([
    db().preference.findUnique({ where: { id: workspace }, select: { reviewRequired: true } }),
    db().user.count({ where: { role: "REVIEWER", active: true } }),
    db().content.count({ where: { status: "IN_REVIEW" } }),
  ]);
  return { required: preference?.reviewRequired ?? false, reviewerCount, pendingCount };
}

export async function setReviewRequired(actor: Actor, value: unknown) {
  assertRole(actor, "ADMIN");
  const input = reviewSettingsSchema.safeParse(value);
  if (!input.success) throw new AppError("请选择是否启用审核。");
  const { required } = input.data;
  try {
    return await db().$transaction(async tx => {
      await requireRoleInTransaction(tx, actor.id, "ADMIN");
      const prior = await tx.preference.findUnique({ where: { id: workspace }, select: { reviewRequired: true } });
      const previous = prior?.reviewRequired ?? false;
      if (required && !await tx.user.findFirst({ where: { role: "REVIEWER", active: true }, select: { id: true } })) {
        throw new AppError("请先添加或启用至少一位审核人。", 409);
      }
      if (previous === required) return { required };
      await tx.preference.upsert({
        where: { id: workspace }, create: { id: workspace, reviewRequired: required }, update: { reviewRequired: required },
      });
      await audit(tx, actor.id, "review.settings_changed", workspace, { previous, required });
      return { required };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code)) {
      throw new AppError("审核设置已被修改，请刷新后重试。", 409);
    }
    throw error;
  }
}

export async function reviewQueue(actor: Actor, pageInput: string | null) {
  assertRole(actor, "REVIEWER");
  const requested = Number(pageInput ?? 1);
  const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(10_000, requested) : 1;
  const where = { status: "IN_REVIEW" as const };
  const [result, total] = await Promise.all([
    db().content.findMany({
      where, take: pageSize, skip: (page - 1) * pageSize,
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      select: { id: true, versions: true, submittedAt: true, owner: { select: { name: true } },
        _count: { select: { tasks: { where: { status: "WAITING_APPROVAL" } } } } },
    }),
    db().content.count({ where }),
  ]);
  return {
    page, pages: Math.max(1, Math.ceil(total / pageSize)), total,
    items: result.map(row => ({
      id: row.id, title: reviewTitle(row.versions), editor: row.owner.name,
      submittedAt: row.submittedAt?.toISOString() ?? null, targets: row._count.tasks,
    })),
  };
}

export async function reviewingContent(actor: Actor, rawId: string) {
  assertRole(actor, "REVIEWER");
  const row = await db().content.findFirst({
    where: { id: contentId(rawId), status: "IN_REVIEW" },
    select: {
      id: true, revision: true, versions: true, submittedAt: true,
      owner: { select: { name: true } },
      tasks: { where: { status: "WAITING_APPROVAL" },
        select: { id: true, platform: true, language: true, mode: true, payload: true, runAt: true,
          account: { select: { name: true } } }, orderBy: [{ runAt: "asc" }, { id: "asc" }] },
      assets: { select: { asset: { select: { id: true, filename: true, kind: true, status: true } } } },
    },
  });
  if (!row) throw new AppError("找不到待审核内容，或内容已由其他审核人处理。", 404);
  const byId = new Map(row.assets.map(link => [link.asset.id, link.asset]));
  const prepareAsset = (id: string) => {
    const asset = byId.get(id);
    return asset ? { id: asset.id, filename: asset.filename, kind: asset.kind, ready: asset.status === "READY" } : undefined;
  };
  const items = row.tasks.map(task => {
    const platform = isPlatform(task.platform) ? platformRules[task.platform] : undefined;
    const parsed = frozenCopy.safeParse(task.payload);
    const copy = parsed.success ? parsed.data : undefined;
    const media = (copy?.assetIds ?? []).flatMap(id => {
      const asset = prepareAsset(id);
      return asset ? [asset] : [];
    });
    const cover = copy?.coverId ? prepareAsset(copy.coverId) : undefined;
    const valid = Boolean(platform && copy && media.every(asset => asset.ready) &&
      media.length === copy.assetIds.length && (!copy.coverId || cover?.ready));
    const options = platform?.options?.flatMap(option => {
      const value = copy?.options[option.key];
      if (value === undefined) return [];
      const label = option.choices?.find(choice => choice.value === String(value))?.label ??
        (typeof value === "boolean" ? value ? "已启用" : "未启用" : String(value));
      return [{ label: option.label, value: label }];
    }) ?? [];
    return {
      id: task.id, platform: platform?.label ?? task.platform, accountName: task.account.name,
      language: task.language, mode: task.mode, runAt: task.runAt.toISOString(),
      scheduled: !row.submittedAt || task.runAt > row.submittedAt,
      copy: copy ? { title: platform?.title ? copy.title : "", body: copy.body, tags: platform?.ownTags ? copy.tags : [] } : null,
      options, media, cover, valid,
    };
  });
  return {
    id: row.id, revision: row.revision, title: reviewTitle(row.versions),
    editor: row.owner.name, submittedAt: row.submittedAt?.toISOString() ?? null, items,
    canApprove: items.length > 0 && items.every(item => item.valid),
  };
}

async function assertReadyTasks(tx: Transaction, id: string) {
  const [tasks, linkedAssets] = await Promise.all([
    tx.publishTask.findMany({
      where: { contentId: id, status: "WAITING_APPROVAL" }, select: { id: true, payload: true, platform: true },
    }),
    tx.contentAsset.findMany({
      where: { contentId: id },
      select: { assetId: true, asset: { select: { status: true } } },
    }),
  ]);
  const ready = new Set(linkedAssets.filter(({ asset }) => asset.status === "READY").map(({ assetId }) => assetId));
  if (!tasks.length || tasks.some(task => {
    const copy = frozenCopy.safeParse(task.payload);
    return !isPlatform(task.platform) || !copy.success || copy.data.assetIds.some(assetId => !ready.has(assetId)) ||
      (copy.data.coverId !== null && !ready.has(copy.data.coverId));
  })) throw new AppError("提交快照中的素材或平台信息无效，请退回内容后重新提交。", 409);
  return tasks.length;
}

type UpdatedTask = { id: string; platform: string; accountId: string; status: TaskStatus };

export async function decideReview(actor: Actor, rawId: string, value: unknown) {
  assertRole(actor, "REVIEWER");
  const input = reviewDecisionSchema.safeParse(value);
  if (!input.success) throw new AppError("请选择审核结果，并填写 1–2000 字的审核意见。");
  const { revision, decision, note } = input.data;
  const id = contentId(rawId);
  const approved = decision === "approve";

  try {
    return await db().$transaction(async tx => {
      await requireRoleInTransaction(tx, actor.id, "REVIEWER");
      if (approved) {
        const content = await tx.content.findUnique({ where: { id }, select: { ownerId: true } });
        if (content && !(await lockPublisher(tx, content.ownerId))?.active) {
          throw new AppError("发布人已停用，请退回内容。", 409);
        }
      }
      await tx.$queryRaw`SELECT "id" FROM "Content" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.content.findUnique({
        where: { id }, select: { revision: true, ownerId: true, versions: true, status: true },
      });
      if (!current || current.status !== "IN_REVIEW" || current.revision !== revision) {
        throw new AppError("内容已被处理或发生变化，请刷新待审核列表。", 409);
      }
      const count = approved ? await assertReadyTasks(tx, id) : await tx.publishTask.count({
        where: { contentId: id, status: "WAITING_APPROVAL" },
      });
      const now = new Date();
      const changed = await tx.content.updateMany({
        where: { id, revision, status: "IN_REVIEW" },
        data: { status: approved ? "SUBMITTED" : "RETURNED", reviewNote: note, revision: { increment: 1 } },
      });
      if (changed.count !== 1) throw new AppError("内容状态刚刚发生变化，请刷新待审核列表。", 409);
      const tasks = approved
        ? await tx.$queryRaw<UpdatedTask[]>`
          UPDATE "PublishTask" SET
            "status" = CASE WHEN "runAt" > ${now} THEN 'SCHEDULED'::"TaskStatus" ELSE 'QUEUED'::"TaskStatus" END,
            "nextRunAt" = GREATEST("runAt", ${now}), "updatedAt" = ${now}
          WHERE "contentId" = ${id} AND "status" = 'WAITING_APPROVAL'
          RETURNING "id", "platform", "accountId", "status"`
        : await tx.publishTask.updateManyAndReturn({
          where: { contentId: id, status: "WAITING_APPROVAL" },
          data: { status: "CANCELLED", nextRunAt: null, errorCode: "review_returned", errorMessage: "审核退回。" },
          select: { id: true, platform: true, accountId: true, status: true },
        });
      if (tasks.length !== count) throw new AppError("审核任务已发生变化，请刷新待审核列表。", 409);
      const record = await tx.review.create({
        data: { contentId: id, reviewerId: actor.id, approved, note }, select: { id: true },
      });
      await audit(tx, actor.id, approved ? "review.approved" : "review.returned", id, { reviewId: record.id, tasks });
      await notify(tx, [current.ownerId], approved ? "review_approved" : "review_returned",
        (approved ? "审核通过 · " : "审核退回 · ") + reviewTitle(current.versions),
        "review:" + record.id, `/contents/${id}${approved ? "/progress" : ""}`);
      return { approved, id, tasks: tasks.length };
    }, { isolationLevel: "ReadCommitted", timeout: 15_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new AppError("内容刚刚被其他审核人处理，请刷新待审核列表。", 409);
    }
    throw error;
  }
}
