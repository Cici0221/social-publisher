import { Prisma } from "@/generated/prisma/client";
import { TaskStatus, type Role } from "@/generated/prisma/enums";
import { draftAssetReferences, draftSchema, type Draft, type DraftCopy } from "@/lib/draft-schema";
import { isPlatform, languageLabels, platformRules, type PlatformKey } from "@/lib/platforms";
import { localPublishTimeToDate, normalizePublishZone, parsePublishDate, type PublishZone } from "@/lib/publish-time";
import { audit } from "./audit";
import type { Actor } from "./auth";
import { db } from "./db";
import { AppError } from "./errors";
import { z } from "zod";

export const statusLabels: Record<TaskStatus, string> = {
  WAITING_APPROVAL: "待审核",
  SCHEDULED: "待定时发布",
  QUEUED: "排队中",
  UPLOADING: "上传中",
  PUBLISHING: "发布中",
  PROCESSING: "平台处理中",
  MANUAL: "待人工发布",
  SUCCESS: "成功",
  FAILED: "失败",
  UNKNOWN: "结果待核对",
  CANCELLED: "已取消",
};

export const historyPageSize = 30;

export type HistoryFilters = {
  platform?: PlatformKey;
  publisherId?: string;
  status?: TaskStatus;
  from?: string;
  through?: string;
  zone: PublishZone;
  page: number;
};

function nextDateKey(date: string) {
  const next = parsePublishDate(date)!;
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function parseHistoryFilters(params: Pick<URLSearchParams, "get">): HistoryFilters {
  const platform = params.get("platform") || undefined;
  const status = params.get("status") || undefined;
  const publisherId = params.get("publisher") || undefined;
  const from = params.get("from") || undefined;
  const through = params.get("through") || undefined;
  const zone = normalizePublishZone(params.get("zone"));
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);

  if (platform && !isPlatform(platform)) throw new AppError("请选择有效的发布平台。");
  if (status && !Object.hasOwn(TaskStatus, status)) throw new AppError("请选择有效的发布状态。");
  if (publisherId && !z.uuid().safeParse(publisherId).success) throw new AppError("请选择有效的发布人。");
  if ((from && !localPublishTimeToDate(from + "T00:00", zone)) ||
      (through && (!parsePublishDate(through) || !localPublishTimeToDate(nextDateKey(through) + "T00:00", zone)))) {
    throw new AppError("请选择有效的发布日期。");
  }
  if (from && through && from > through) throw new AppError("结束日期须等于或晚于开始日期。");
  return { platform: platform as PlatformKey | undefined, status: status as TaskStatus | undefined, publisherId, from, through, zone, page: Math.min(2_000_000, page) };
}

export function publisherScope(actor: Pick<Actor, "id" | "role">): Prisma.PublishTaskWhereInput {
  if (actor.role === "ADMIN") return {};
  if (actor.role === "EDITOR") return { publisherId: actor.id };
  throw new AppError("没有查看发布记录的权限。", 403);
}

export function historyWhere(actor: Pick<Actor, "id" | "role">, filters: HistoryFilters): Prisma.PublishTaskWhereInput {
  const scope = publisherScope(actor);
  const start = filters.from ? localPublishTimeToDate(filters.from + "T00:00", filters.zone) : null;
  const end = filters.through ? localPublishTimeToDate(nextDateKey(filters.through) + "T00:00", filters.zone) : null;
  const period = { gte: start ?? undefined, lt: end ?? undefined };
  return {
    AND: [
      scope,
      { platform: filters.platform, status: filters.status, publisherId: filters.publisherId },
      ...(start || end ? [{ OR: [{ publishedAt: period }, { publishedAt: null, runAt: period }] }] : []),
    ],
  };
}

export const historySelect = {
  id: true, contentId: true, status: true, platform: true, mode: true, language: true,
  runAt: true, publishedAt: true, createdAt: true, payload: true, postUrl: true, errorMessage: true,
  account: { select: { name: true } }, publisher: { select: { id: true, name: true } },
  confirmer: { select: { name: true } },
} as const satisfies Prisma.PublishTaskSelect;

export type HistoryRow = Prisma.PublishTaskGetPayload<{ select: typeof historySelect }>;
const orderBy = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.PublishTaskOrderByWithRelationInput[];

export async function listHistory(actor: Pick<Actor, "id" | "role">, filters: HistoryFilters) {
  const rows = await db().publishTask.findMany({
    where: historyWhere(actor, filters), orderBy, select: historySelect,
    skip: (filters.page - 1) * historyPageSize, take: historyPageSize + 1,
  });
  return { rows: rows.slice(0, historyPageSize), hasMore: rows.length > historyPageSize };
}

export function historyPublishers(role: Role) {
  if (role !== "ADMIN") return Promise.resolve([]);
  return db().user.findMany({
    where: { published: { some: {} } }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export function copyText(payload: Prisma.JsonValue) {
  const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  return {
    title: typeof data.title === "string" ? data.title : "",
    body: typeof data.body === "string" ? data.body : "",
    tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

export function platformLabel(platform: string) {
  return isPlatform(platform) ? platformRules[platform].label : platform;
}

export function modeLabel(mode: HistoryRow["mode"]) {
  if (mode === "MOCK") return "模拟";
  return mode === "MANUAL" ? "半自动" : "官方直发";
}

export function recordCopyLabel(row: Pick<HistoryRow, "mode" | "status">) {
  if (row.mode === "MOCK") return "模拟文案";
  if (row.mode === "MANUAL") return row.status === "SUCCESS" ? "已确认文案" : "素材包文案";
  return row.status === "SUCCESS" ? "实际发布文案" : "任务文案";
}

export function verifiedPostUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function csvCell(value: string) {
  const looksLikeFormula = /^[\p{White_Space}\p{Cf}\p{Cc}]*[=+\-@＝＋－＠]/u.test(value) || /^[\t\r\n]/.test(value);
  return '"' + ((looksLikeFormula ? "'" : "") + value).replaceAll('"', '""') + '"';
}

function csvLine(fields: string[]) {
  return fields.map(csvCell).join(",") + "\r\n";
}

function csvRow(row: HistoryRow) {
  const copy = copyText(row.payload);
  return csvLine([
    row.id, row.contentId, platformLabel(row.platform), row.account.name, row.publisher.name, row.confirmer?.name ?? "",
    modeLabel(row.mode), statusLabels[row.status],
    row.mode === "LIVE" ? row.publishedAt?.toISOString() ?? "" : "",
    row.mode === "MANUAL" ? row.publishedAt?.toISOString() ?? "" : "",
    row.mode === "MOCK" ? row.publishedAt?.toISOString() ?? "" : "",
    row.runAt.toISOString(),
    row.createdAt.toISOString(), languageLabels[row.language], recordCopyLabel(row), copy.title, copy.body,
    copy.tags.join(" "), row.mode === "MOCK" ? "" : verifiedPostUrl(row.postUrl) ?? "", row.errorMessage ?? "",
  ]);
}

export function exportHistory(actor: Pick<Actor, "id" | "role">, filters: HistoryFilters) {
  const where = historyWhere(actor, filters);
  const encoder = new TextEncoder();
  async function* streamRows() {
    yield "\uFEFF" + csvLine([
      "任务编号", "内容编号", "平台", "平台账号", "发布人", "人工确认人", "发布方式", "状态",
      "实际发布时间（UTC）", "人工确认时间（UTC）", "模拟完成时间（UTC）", "计划时间（UTC）", "提交时间（UTC）", "语言", "文案类型", "标题", "正文", "话题", "帖子链接", "失败原因",
    ]);
    let cursor: Pick<HistoryRow, "id" | "createdAt"> | undefined;
    for (;;) {
      const rows: HistoryRow[] = await db().publishTask.findMany({
        where: cursor ? {
          AND: [where, { OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ] }],
        } : where,
        select: historySelect, orderBy, take: 200,
      });
      for (const row of rows) yield csvRow(row);
      if (rows.length < 200) return;
      cursor = rows.at(-1)!;
    }
  }
  const rows = streamRows();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await rows.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() { await rows.return(undefined); },
  });
}

type LockedAsset = { id: string; status: string; kind: string };

export function copyDraftWithAssets(draft: Pick<Draft, "versions" | "overrides">, rows: LockedAsset[]): Draft {
  const ready = new Map(rows.filter(row => row.status === "READY").map(row => [row.id, row.kind]));
  function keepAvailable(copy: DraftCopy) {
    return {
      ...copy, assetIds: copy.assetIds.filter(id => ready.has(id)),
      coverId: copy.coverId && ready.get(copy.coverId) === "IMAGE" ? copy.coverId : null,
    };
  }
  const versions: Draft["versions"] = { ZH: keepAvailable(draft.versions.ZH) };
  for (const language of ["EN", "JA", "VI"] as const) {
    const copy = draft.versions[language];
    if (copy) versions[language] = keepAvailable(copy);
  }
  const overrides: Draft["overrides"] = {};
  for (const [platform, copies] of Object.entries(draft.overrides)) {
    if (!isPlatform(platform) || !copies) continue;
    const available: NonNullable<Draft["overrides"][PlatformKey]> = {};
    for (const language of ["ZH", "EN", "JA", "VI"] as const) {
      const copy = copies[language];
      if (copy) available[language] = keepAvailable(copy);
    }
    if (Object.keys(available).length) overrides[platform] = available;
  }
  return { versions, overrides, selections: [] };
}

export async function copyHistory(actor: Pick<Actor, "id" | "role">, contentId: string) {
  publisherScope(actor);
  if (!z.uuid().safeParse(contentId).success) throw new AppError("发布记录不存在。", 404);

  return db().$transaction(async tx => {
    const member = await tx.user.findUnique({ where: { id: actor.id }, select: { id: true, active: true, role: true } });
    if (!member?.active) throw new AppError("账号当前不可用。", 403);
    const taskScope = publisherScope(member);
    const lock = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Content" WHERE "id" = ${contentId}
      AND (${member.role === "ADMIN"} OR "ownerId" = ${actor.id}) FOR UPDATE`;
    const source = lock.length ? await tx.content.findFirst({
      where: { id: contentId, tasks: { some: taskScope } },
      select: { versions: true, overrides: true },
    }) : null;
    if (!source) throw new AppError("发布记录不存在。", 404);
    const parsed = draftSchema.safeParse({ ...source, selections: [] });
    if (!parsed.success) throw new AppError("这条历史内容的文案结构无法复制。", 422);

    const originalIds = draftAssetReferences(parsed.data).assetIds;
    const assets = originalIds.length ? await tx.$queryRaw<LockedAsset[]>`
      SELECT "id", "status", "kind" FROM "Asset" WHERE "id" IN (${Prisma.join(originalIds)}) ORDER BY "id" FOR UPDATE` : [];
    const draft = copyDraftWithAssets(parsed.data, assets);
    const { assetIds } = draftAssetReferences(draft);
    const result = await tx.content.create({ data: { ownerId: actor.id, ...draft }, select: { id: true } });
    if (assetIds.length) {
      await tx.contentAsset.createMany({ data: assetIds.map(assetId => ({ contentId: result.id, assetId })) });
    }
    await audit(tx, actor.id, "history.copied", result.id, { source: contentId });
    return { id: result.id, removedAssets: originalIds.length - assetIds.length };
  });
}
