import { z } from "zod";
import { draftCopySchema, draftLanguages, type DraftLanguage } from "@/lib/draft-schema";
import { platformRules } from "@/lib/platforms";
import { isManualPlatform, manualBackend, manualUrl } from "@/platforms/manual-policy";
import { mediaForAsset } from "@/server/assets/service";
import { audit } from "@/server/audit";
import type { Actor } from "@/server/auth";
import { digest } from "@/server/crypto";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { manualPackageStream } from "@/server/manual-zip";
import { notify } from "@/server/notices";

const taskPayload = draftCopySchema.extend({
  body: z.string().max(120_000),
  language: z.enum(draftLanguages),
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export const manualConfirmationSchema = z.strictObject({
  postUrl: z.string().trim().min(1).max(4096),
  actualTitle: z.string().max(500).optional(),
  actualBody: z.string().max(120_000).optional(),
});

const taskView = {
  id: true, contentId: true, publisherId: true, platform: true, status: true, payload: true, postUrl: true, publishedAt: true,
  account: { select: { name: true, backendUrl: true } },
} as const;

export async function saveManualAccount(actor: Actor, key: string, name: string, language: DraftLanguage, backendUrl?: string | null) {
  if (actor.role !== "ADMIN" || !actor.active) throw new AppError("只有管理员可以登记半自动账号。", 403);
  const label = name.trim();
  if (!isManualPlatform(key) || !label || label.length > 100 || !draftLanguages.includes(language)) {
    throw new AppError("请选择半自动平台并填写账号名称与默认语言。", 422);
  }
  const backend = manualBackend(key, backendUrl);
  if (!backend) throw new AppError("请填写该平台的官方后台 HTTPS 地址。", 422);
  const mode = "MANUAL" as const;
  const externalId = digest(`manual:${key}:${label.normalize("NFKC").toLowerCase()}`);
  return db().$transaction(async tx => {
    const row = await tx.platformAccount.upsert({
      where: { platform_externalId_mode: { platform: key, externalId, mode } },
      create: { platform: key, externalId, name: label, mode, language, backendUrl: backend },
      update: { name: label, language, backendUrl: backend, status: "ACTIVE" },
      select: { id: true, name: true, platform: true, language: true, backendUrl: true, mode: true, status: true },
    });
    await audit(tx, actor.id, "account.manual.save", row.id, { platform: key });
    return row;
  });
}

async function visibleTask(actor: Actor, id: string) {
  const task = await db().publishTask.findFirst({
    where: { id, mode: "MANUAL", status: { in: ["MANUAL", "SUCCESS"] }, ...(actor.role === "ADMIN" ? {} : { publisherId: actor.id }) },
    select: taskView,
  });
  if (!task || !isManualPlatform(task.platform)) throw new AppError("找不到可访问的半自动发布任务。", 404);
  const backendUrl = manualBackend(task.platform, task.account.backendUrl);
  if (!backendUrl) throw new AppError("官方后台地址不可用，请联系管理员。", 422);
  const payload = taskPayload.parse(task.payload);
  const rule = platformRules[task.platform];
  return { task, payload, backendUrl, hasTitle: Boolean(rule.title), platformLabel: rule.label };
}

function copyText(payload: z.infer<typeof taskPayload>, hasTitle: boolean) {
  return [hasTitle ? payload.title : "", payload.body].filter(Boolean).join("\n\n");
}

function packageAssetIds(payload: z.infer<typeof taskPayload>) {
  return [...new Set([...payload.assetIds, ...(payload.coverId ? [payload.coverId] : [])])];
}

export async function getManualDelivery(actor: Actor, id: string) {
  const { task, payload, backendUrl, hasTitle, platformLabel } = await visibleTask(actor, id);
  const ids = packageAssetIds(payload);
  const ready = ids.length ? await db().asset.count({ where: { id: { in: ids }, status: "READY" } }) : 0;
  return {
    id: task.id, platformLabel, accountName: task.account.name, backendUrl, title: hasTitle ? payload.title : "", body: payload.body,
    copy: copyText(payload, hasTitle), hasTitle, postUrl: task.postUrl, publishedAt: task.publishedAt?.toISOString() ?? null,
    canConfirm: task.status === "MANUAL" && task.publisherId === actor.id,
    canDownload: ready === ids.length,
  };
}

export async function confirmManual(actor: Actor, id: string, confirmed: z.infer<typeof manualConfirmationSchema>) {
  return db().$transaction(async tx => {
    const pick = () => tx.publishTask.findFirst({ where: { id, publisherId: actor.id, mode: "MANUAL" }, select: taskView });
    const task = await pick();
    if (!task || !isManualPlatform(task.platform)) throw new AppError("找不到可确认的半自动发布任务。", 404);
    const url = manualUrl(task.platform, confirmed.postUrl, "post");
    if (!url) throw new AppError("请填写该平台发布后的官方帖子链接。", 422);
    const payload = taskPayload.parse(task.payload);
    const snapshot = { ...payload,
      title: confirmed.actualTitle ?? payload.title,
      body: confirmed.actualBody ?? payload.body,
    };
    function replay(current: NonNullable<typeof task>) {
      const latest = taskPayload.parse(current.payload);
      if (current.status === "SUCCESS" && current.postUrl === url && current.publishedAt &&
          (confirmed.actualTitle === undefined || confirmed.actualTitle === latest.title) &&
          (confirmed.actualBody === undefined || confirmed.actualBody === latest.body)) {
        return { postUrl: url, publishedAt: current.publishedAt.toISOString() };
      }
      throw new AppError("这个任务已被处理或尚未到达人工发布阶段。", 409);
    }

    if (task.status !== "MANUAL") return replay(task);
    const publishedAt = new Date();
    const result = await tx.publishTask.updateMany({
      where: { id, publisherId: actor.id, status: "MANUAL", mode: "MANUAL" },
      data: { status: "SUCCESS", postUrl: url, publishedAt, confirmerId: actor.id, payload: snapshot, errorCode: null, errorMessage: null },
    });
    if (result.count !== 1) {
      const current = await pick();
      if (current) return replay(current);
      throw new AppError("找不到可确认的半自动发布任务。", 404);
    }
    await audit(tx, actor.id, "publish.manual.confirm", id, { platform: task.platform, contentId: task.contentId });
    await notify(tx, [task.publisherId], "publish_success", `${platformRules[task.platform].label} 已确认发布。`, `manual-published:${id}`, `/contents/${task.contentId}/progress`);
    return { postUrl: url, publishedAt: publishedAt.toISOString() };
  });
}

export async function manualPackage(actor: Actor, id: string, signal?: AbortSignal) {
  const { payload, hasTitle } = await visibleTask(actor, id);
  const ids = packageAssetIds(payload);
  const assets = await Promise.all(ids.map(async assetId => {
    const asset = await mediaForAsset(assetId);
    return {
      filename: asset.filename, cover: assetId === payload.coverId,
      stream: async () => {
        const object = await asset.open();
        if (!object.Body) throw new AppError("素材无法打开。", 500);
        return object.Body.transformToWebStream() as ReadableStream<Uint8Array>;
      },
    };
  }));
  return new Response(manualPackageStream(copyText(payload, hasTitle), assets, signal), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="publication-${id}.zip"; filename*=UTF-8''${encodeURIComponent("发布素材包.zip")}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
