import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { Actor } from "../auth";
import { audit } from "../audit";
import { db, type Transaction } from "../db";
import { AppError } from "../errors";
import {
  assertCompleteParts, checkedUpload, expectedPartBytes, UPLOAD_LIFETIME_MS,
  UPLOAD_PART_BYTES, urlSafeFilename, verifiedParts,
} from "./limits";
import { inspectAsset } from "./metadata";
import {
  abortObject, beginObject, completeObject, deleteObject, headObjectBytes, listObjectParts,
  readObject, signProviderAsset, signUploadPart, storeThumbnail,
} from "./storage";

const noFolders = "unfiled";
const processingLeaseMs = 10 * 60_000;
const pendingDate = new Date(0);
const cleanupPending = "storage_cleanup_pending";
const resumableSchema = z.object({
  filename: z.string().min(1).max(250), mime: z.string().max(100),
  bytes: z.number().int(), resumeId: z.uuid().optional(),
});
const editSchema = z.object({
  folderId: z.uuid().nullable(),
  tags: z.array(z.string().trim().min(1).max(32)).max(20),
}).strict();

type Upload = Awaited<ReturnType<typeof loadUpload>>;
const assetInclude = {
  uploader: { select: { id: true, name: true } },
  folder: { select: { id: true, name: true } },
  _count: { select: { references: true } },
} as const;
type AssetRow = Prisma.AssetGetPayload<{ include: typeof assetInclude }>;

function validId(value: string) {
  if (!z.uuid().safeParse(value).success) throw new AppError("素材不存在。", 404);
  return value;
}

export function canManageAssets(actor: Actor) {
  return actor.role === "ADMIN" || actor.role === "EDITOR";
}

function canEditAsset(actor: Actor, uploaderId: string) {
  return actor.role === "ADMIN" || (actor.role === "EDITOR" && actor.id === uploaderId);
}

function assetJson(row: AssetRow, actor: Actor) {
  return {
    id: row.id, filename: row.filename, mime: row.mime, bytes: Number(row.bytes),
    kind: row.kind, status: row.status, width: row.width, height: row.height, duration: row.duration,
    error: row.status === "FAILED" ? row.error : null, folderId: row.folderId, folderName: row.folder?.name,
    tags: row.tags, uploaderId: row.uploader.id, uploaderName: row.uploader.name,
    createdAt: row.createdAt.toISOString(), canEdit: canEditAsset(actor, row.uploaderId),
    referenceCount: row._count.references,
  };
}

function dayBoundary(value: string | null, end: boolean) {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError("请填写有效日期。");
  const start = new Date(value + "T00:00:00+08:00");
  if (!Number.isFinite(+start) || new Date(+start + 8 * 60 * 60_000).toISOString().slice(0, 10) !== value) {
    throw new AppError("请填写有效日期。");
  }
  return end ? new Date(+start + 24 * 60 * 60_000) : start;
}

export async function listAssets(actor: Actor, query: URLSearchParams) {
  const name = query.get("q")?.trim().slice(0, 100);
  const tag = query.get("tag")?.trim().normalize("NFC").slice(0, 32);
  const uploader = query.get("uploader");
  const folder = query.get("folder");
  const status = query.get("status") === "READY" ? "READY" : { not: "DELETED" as const };
  const from = dayBoundary(query.get("from"), false);
  const until = dayBoundary(query.get("until"), true);
  if (from && until && from >= until) throw new AppError("结束日期必须晚于或等于起始日期。");

  const limit = Math.min(96, Math.max(1, Number.parseInt(query.get("limit") ?? "48", 10) || 48));
  const page = Math.min(10_000, Math.max(1, Number.parseInt(query.get("page") ?? "1", 10) || 1));
  const where: Prisma.AssetWhereInput = {
    status,
    ...(name ? { filename: { contains: name, mode: "insensitive" } } : {}),
    ...(tag ? { tags: { has: tag } } : {}),
    ...(uploader ? { uploaderId: validId(uploader) } : {}),
    ...(folder ? { folderId: folder === noFolders ? null : validId(folder) } : {}),
    ...(from || until ? { createdAt: { gte: from, lt: until } } : {}),
  };
  const [rows, total, folders, uploaders] = await Promise.all([
    db().asset.findMany({ where, include: assetInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit, take: limit }),
    db().asset.count({ where }),
    db().assetFolder.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db().user.findMany({ where: { assets: { some: { status: { not: "DELETED" } } } },
      select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return { assets: rows.map(row => assetJson(row, actor)), folders, uploaders, total, page, limit };
}

export type AssetList = Awaited<ReturnType<typeof listAssets>>;
export type AssetSummary = AssetList["assets"][number];

export async function createFolder(actor: Actor, input: unknown) {
  if (!canManageAssets(actor)) throw new AppError("无权创建素材文件夹。", 403);
  const name = z.object({ name: z.string().trim().min(1).max(48) }).safeParse(input);
  if (!name.success) throw new AppError("文件夹名称须为 1–48 个字符。");
  const clean = name.data.name.normalize("NFC");
  if (/[\u0000-\u001f\u007f]/u.test(clean)) throw new AppError("文件夹名称包含不支持的字符。");
  const folder = await db().assetFolder.upsert({
    where: { name: clean }, create: { name: clean }, update: {}, select: { id: true, name: true },
  });
  return folder;
}

async function lockAsset(tx: Transaction, id: string) {
  // Draft writes take the same row locks before updating ContentAsset.
  await tx.$queryRaw`SELECT "id" FROM "Asset" WHERE "id" = ${id} FOR UPDATE`;
  const asset = await tx.asset.findUnique({ where: { id } });
  if (!asset || asset.status === "DELETED") throw new AppError("素材不存在。", 404);
  return asset;
}

export async function editAsset(actor: Actor, id: string, input: unknown) {
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) throw new AppError("请选择文件夹，并填写最多 20 个不超过 32 字的标签。");
  const tags = [...new Set(parsed.data.tags.map(tag => tag.normalize("NFC")))];
  if (tags.some(tag => /[\u0000-\u001f\u007f]/u.test(tag))) throw new AppError("标签含有无效字符。");
  const row = await db().$transaction(async tx => {
    const asset = await lockAsset(tx, validId(id));
    if (!canEditAsset(actor, asset.uploaderId)) throw new AppError("仅上传者或管理员可以整理该素材。", 403);
    if (parsed.data.folderId && !await tx.assetFolder.findUnique({ where: { id: parsed.data.folderId } })) {
      throw new AppError("该文件夹已不存在。", 404);
    }
    return tx.asset.update({ where: { id }, data: { tags, folderId: parsed.data.folderId,
      ...(asset.status === "PROCESSING" ? { updatedAt: asset.updatedAt } : {}) },
      include: assetInclude });
  });
  return assetJson(row, actor);
}

function versionLabel(versions: Prisma.JsonValue) {
  if (versions && typeof versions === "object" && !Array.isArray(versions)) {
    const locales = ["ZH", "EN", "JA", "VI"];
    for (const language of locales) {
      const candidate = versions[language];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
          typeof candidate.title === "string" && candidate.title.trim()) return candidate.title.slice(0, 250);
    }
  }
  return "未命名内容";
}

async function referenceList(client: Transaction, id: string, actor: Actor) {
  const references = await client.contentAsset.findMany({
    where: { assetId: id }, orderBy: { contentId: "asc" },
    select: { content: { select: { id: true, ownerId: true, status: true, versions: true } } },
  });
  return references.map(({ content }) => ({
    id: content.id, title: versionLabel(content.versions), status: content.status,
    canOpen: actor.role === "ADMIN" || content.ownerId === actor.id,
  }));
}
export type AssetReference = Awaited<ReturnType<typeof referenceList>>[number];

export async function assetReferences(actor: Actor, id: string) {
  const asset = await db().asset.findUnique({ where: { id: validId(id) }, select: { status: true, uploaderId: true } });
  if (!asset || asset.status === "DELETED") throw new AppError("素材不存在。", 404);
  if (!canEditAsset(actor, asset.uploaderId)) throw new AppError("无权查看该素材的删除影响。", 403);
  return referenceList(db(), id, actor);
}

export async function removeAsset(actor: Actor, id: string) {
  return db().$transaction(async tx => {
    const asset = await lockAsset(tx, validId(id));
    if (!canEditAsset(actor, asset.uploaderId)) throw new AppError("仅上传者或管理员可以删除该素材。", 403);
    const references = await referenceList(tx, id, actor);
    if (references.length) return { deleted: false as const, references };
    await tx.asset.update({ where: { id }, data: { status: "DELETED", error: cleanupPending } });
    await audit(tx, actor.id, "asset.delete", id);
    return { deleted: true as const, references: [] };
  });
}

async function loadUpload(actor: Actor, id: string, client: Transaction = db()) {
  const row = await client.uploadSession.findUnique({ where: { id: validId(id) } });
  if (!row || row.ownerId !== actor.id) throw new AppError("上传记录不存在。", 404);
  return row;
}

function assertUploadOpen(upload: Upload) {
  if (upload.expiresAt <= new Date()) throw new AppError("上传会话已过期。请选择文件重新上传。", 410);
}

async function uploadStatus(upload: Upload) {
  const asset = await db().asset.findUnique({ where: { objectKey: upload.objectKey },
    select: { id: true, status: true } });
  if (upload.complete && asset?.status === "DELETED") throw new AppError("此前上传的素材已删除。", 410);
  const bytes = Number(upload.bytes);
  const objectComplete = upload.complete || await headObjectBytes(upload.objectKey) === bytes;
  const uploadedParts = objectComplete ? Array.from({ length: Math.ceil(bytes / UPLOAD_PART_BYTES) }, (_, i) => i + 1)
    : verifiedParts(bytes, await listObjectParts(upload.objectKey, upload.multipartId)).map(part => part.PartNumber);
  return { id: upload.id, bytes, partBytes: UPLOAD_PART_BYTES, uploadedParts,
    complete: upload.complete, assetId: asset?.id, assetStatus: asset?.status, expiresAt: upload.expiresAt.toISOString() };
}

export async function startUpload(actor: Actor, input: unknown) {
  if (!canManageAssets(actor)) throw new AppError("无权上传素材。", 403);
  const parsed = resumableSchema.safeParse(input);
  if (!parsed.success) throw new AppError("上传信息不完整。");
  const { filename, mime, bytes, kind, extension } = checkedUpload(
    parsed.data.filename, parsed.data.mime, parsed.data.bytes,
  );
  if (parsed.data.resumeId) {
    const remembered = await loadUpload(actor, parsed.data.resumeId);
    if (remembered.bytes !== BigInt(bytes) || remembered.filename !== filename || remembered.mime !== mime) {
      throw new AppError("文件与续传会话不匹配。", 409);
    }
    if (!remembered.complete) assertUploadOpen(remembered);
    return uploadStatus(remembered);
  }
  const objectKey = `originals/${randomUUID()}.${extension}`;
  const multipartId = await beginObject(objectKey, mime);
  try {
    const session = await db().uploadSession.create({
      data: { ownerId: actor.id, filename, mime, kind, bytes: BigInt(bytes), objectKey, multipartId,
        expiresAt: new Date(Date.now() + UPLOAD_LIFETIME_MS) },
    });
    return { id: session.id, bytes, partBytes: UPLOAD_PART_BYTES, uploadedParts: [],
      complete: false, assetId: undefined, assetStatus: undefined, expiresAt: session.expiresAt.toISOString() };
  } catch (error) {
    await abortObject(objectKey, multipartId).catch(() => undefined);
    throw error;
  }
}

export async function getUpload(actor: Actor, id: string) {
  const session = await loadUpload(actor, id);
  if (!session.complete) assertUploadOpen(session);
  return uploadStatus(session);
}

export async function uploadPartUrl(actor: Actor, id: string, part: number) {
  if (!canManageAssets(actor)) throw new AppError("无权上传素材。", 403);
  const session = await loadUpload(actor, id);
  assertUploadOpen(session);
  if (session.complete) throw new AppError("素材已完成上传。", 409);
  const length = expectedPartBytes(Number(session.bytes), part);
  const expiresIn = Math.max(1, Math.min(900, Math.floor((+session.expiresAt - Date.now()) / 1000)));
  return { url: await signUploadPart(session.objectKey, session.multipartId, part, length, expiresIn), length };
}

async function lockUpload(tx: Transaction, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "UploadSession" WHERE "id" = ${id} FOR UPDATE`;
}

async function registerAsset(tx: Transaction, session: Upload) {
  const asset = await tx.asset.upsert({ where: { objectKey: session.objectKey },
    create: {
      objectKey: session.objectKey, filename: session.filename, mime: session.mime, bytes: session.bytes,
      kind: session.kind === "VIDEO" ? "VIDEO" : "IMAGE", uploaderId: session.ownerId, updatedAt: pendingDate,
    }, update: {}, select: { id: true, status: true } });
  await tx.uploadSession.update({ where: { id: session.id }, data: { complete: true } });
  return asset;
}

export async function finishUpload(actor: Actor, id: string) {
  if (!canManageAssets(actor)) throw new AppError("无权上传素材。", 403);
  return db().$transaction(async tx => {
    await lockUpload(tx, validId(id));
    const session = await loadUpload(actor, id, tx);
    if (session.complete) {
      const asset = await tx.asset.findUnique({ where: { objectKey: session.objectKey },
        select: { id: true, status: true } });
      if (!asset || asset.status === "DELETED") throw new AppError("此前上传的素材已删除。", 410);
      return asset;
    }
    const bytes = Number(session.bytes);
    const stored = await headObjectBytes(session.objectKey);
    if (stored === undefined) {
      assertUploadOpen(session);
      const parts = assertCompleteParts(bytes, await listObjectParts(session.objectKey, session.multipartId));
      await completeObject(session.objectKey, session.multipartId, parts);
    }
    if (await headObjectBytes(session.objectKey) !== bytes) {
      throw new AppError("对象存储中的文件大小不一致，无法入库。", 422);
    }
    return registerAsset(tx, session);
  }, { timeout: 60_000 });
}

function claimThreshold() {
  return new Date(Date.now() - processingLeaseMs);
}

async function processAsset(candidate: { id: string }) {
  const lease = new Date();
  const claimed = await db().asset.updateMany({
    where: { id: candidate.id, status: "PROCESSING", updatedAt: { lte: claimThreshold() } },
    data: { updatedAt: lease },
  });
  if (!claimed.count) return;
  const asset = await db().asset.findUnique({ where: { id: candidate.id } });
  if (!asset || asset.status !== "PROCESSING" || +asset.updatedAt !== +lease) return;
  const guard = { id: asset.id, status: "PROCESSING" as const, updatedAt: lease };
  const thumbnailKey = `thumbnails/${asset.id}.jpg`;
  try {
    const info = await inspectAsset(asset);
    await storeThumbnail(thumbnailKey, info.thumbnail);
    const completed = await db().asset.updateMany({ where: guard,
      data: { status: "READY", width: info.width, height: info.height, duration: info.duration,
        thumbKey: thumbnailKey, error: null } });
    if (!completed.count) {
      const current = await db().asset.findUnique({ where: { id: asset.id }, select: { status: true } });
      if (current?.status === "DELETED") {
        await deleteObject(thumbnailKey).catch(() => db().asset.updateMany({
          where: { id: asset.id, status: "DELETED" }, data: { error: cleanupPending },
        }));
      }
    }
  } catch (error) {
    if (error instanceof AppError && error.status === 422) {
      await db().asset.updateMany({ where: guard, data: { status: "FAILED", error: error.message } });
    } else {
      const retry = new Date(+claimThreshold() + 30_000);
      await db().asset.updateMany({ where: guard, data: { updatedAt: retry } });
    }
  }
}

async function reapUpload(id: string) {
  await db().$transaction(async tx => {
    await lockUpload(tx, id);
    const session = await tx.uploadSession.findUnique({ where: { id } });
    if (!session || session.expiresAt > new Date()) return;
    if (!session.complete) {
      const bytes = await headObjectBytes(session.objectKey);
      if (bytes === Number(session.bytes)) await registerAsset(tx, session);
      else {
        await abortObject(session.objectKey, session.multipartId);
        if (bytes !== undefined) await deleteObject(session.objectKey);
      }
    }
    await tx.uploadSession.delete({ where: { id } });
  }, { timeout: 30_000 });
}

export async function runAssetMaintenance() {
  const [pending, deleted, expired] = await Promise.all([
    db().asset.findMany({ where: { status: "PROCESSING", updatedAt: { lte: claimThreshold() } },
      orderBy: { updatedAt: "asc" }, select: { id: true }, take: 6 }),
    db().asset.findMany({ where: { status: "DELETED", error: cleanupPending },
      select: { id: true, objectKey: true }, take: 12 }),
    db().uploadSession.findMany({ where: { expiresAt: { lte: new Date() } }, select: { id: true }, take: 12 }),
  ]);
  for (const row of deleted) {
    const removals = await Promise.allSettled([
      deleteObject(row.objectKey), deleteObject(`thumbnails/${row.id}.jpg`),
    ]);
    if (removals.every(item => item.status === "fulfilled")) {
      await db().asset.updateMany({ where: { id: row.id, status: "DELETED" }, data: { error: null, thumbKey: null } });
    }
  }
  for (const row of expired) await reapUpload(row.id).catch(() => undefined);
  for (const row of pending) await processAsset(row);
}

let maintenance: Promise<void> | undefined;

export async function wakeAssetMaintenance() {
  maintenance ??= runAssetMaintenance().catch(() => undefined).finally(() => { maintenance = undefined; });
  await maintenance;
}

export async function mediaForAsset(id: string) {
  const asset = await db().asset.findUnique({ where: { id: validId(id) },
    select: { id: true, objectKey: true, thumbKey: true, filename: true,
      mime: true, bytes: true, kind: true, status: true, width: true, height: true, duration: true } });
  if (!asset || asset.status !== "READY") throw new AppError("素材尚未就绪或已删除。", 404);
  const { objectKey, thumbKey, status: _status, ...meta } = asset;
  return {
    ...meta, bytes: Number(meta.bytes),
    open: (range?: string) => readObject(objectKey, range),
    openThumbnail: () => {
      if (!thumbKey) throw new AppError("素材缩略图不存在。", 404);
      return readObject(thumbKey);
    },
    providerGetUrl: (expiresIn: number) => signProviderAsset(objectKey, meta.mime, meta.filename, expiresIn),
  };
}

function singleRange(range: string | null, bytes: number) {
  if (!range) return undefined;
  const match = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, bytes - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(bytes - 1, Number(match[2])) : bytes - 1;
  if (start >= bytes || end < start || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  return `bytes=${start}-${end}`;
}

export async function assetFileResponse(id: string, thumbnail: boolean, range: string | null) {
  const media = await mediaForAsset(id);
  const selected = thumbnail ? undefined : singleRange(range, media.bytes);
  if (selected === null) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${media.bytes}` } });
  const object = thumbnail ? await media.openThumbnail() : await media.open(selected);
  if (!object.Body) throw new AppError("素材文件不存在。", 404);
  const headers = new Headers({
    "Content-Type": thumbnail ? "image/jpeg" : media.mime,
    "Cache-Control": thumbnail ? "private, max-age=300" : "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (!thumbnail) {
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${urlSafeFilename(media.filename)}`);
  }
  if (object.ContentLength !== undefined) headers.set("Content-Length", String(object.ContentLength));
  if (object.ContentRange) headers.set("Content-Range", object.ContentRange);
  return new Response(object.Body.transformToWebStream() as ReadableStream<Uint8Array>, { headers, status: selected ? 206 : 200 });
}
