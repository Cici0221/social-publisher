import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { draftAssetReferences, draftSchema, emptyDraft, type DraftUpdate, type presetInputSchema } from "@/lib/draft-schema";
import { platformKeys, type PlatformKey } from "@/lib/platforms";

const draftFields = {
  id: true, revision: true, status: true, updatedAt: true, reviewNote: true,
  versions: true, overrides: true, selections: true,
} as const;
const editable = ["DRAFT", "RETURNED"] as const;

export async function listDrafts(ownerId: string) {
  const rows = await db().content.findMany({
    where: { ownerId, status: { in: [...editable] } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, status: true, updatedAt: true, versions: true },
  });
  return rows.map(({ versions, updatedAt, ...row }) => ({
    ...row,
    title: draftSchema.shape.versions.safeParse(versions).data?.ZH.title.trim() || "未命名草稿",
    updatedAt: updatedAt.toISOString(),
  }));
}

export async function createDraft(ownerId: string) {
  const draft = emptyDraft();
  return db().content.create({ data: { ownerId, ...draft }, select: { id: true } });
}

export async function findDraft(ownerId: string, id: string) {
  const row = await db().content.findFirst({ where: { id, ownerId, status: { in: [...editable] } }, select: draftFields });
  if (!row) return null;
  const { versions, overrides, selections, updatedAt, ...rest } = row;
  return { ...rest, updatedAt: updatedAt.toISOString(), draft: draftSchema.parse({ versions, overrides, selections }) };
}

export async function saveDraft(ownerId: string, id: string, { draft, revision }: DraftUpdate) {
  const { assetIds, coverIds } = draftAssetReferences(draft);
  const accountIds = draft.selections.map(entry => entry.accountId);
  const updatedAt = new Date();
  return db().$transaction(async tx => {
    const claimed = await tx.content.updateMany({
      where: { id, ownerId, revision, status: { in: [...editable] } },
      data: { ...draft, updatedAt, revision: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      const current = await tx.content.findFirst({ where: { id, ownerId }, select: draftFields });
      if (!current) throw new AppError("草稿不存在。", 404);
      // A retry after a lost response can reuse the already-committed revision.
      if (current.revision === revision + 1 && (current.status === "DRAFT" || current.status === "RETURNED")) {
        const stored = draftSchema.parse({ versions: current.versions, overrides: current.overrides, selections: current.selections });
        if (isDeepStrictEqual(stored, draft)) return { id, revision: current.revision, updatedAt: current.updatedAt.toISOString() };
      }
      throw new AppError("草稿在其他页面已更新或已提交。", 409);
    }

    if (assetIds.length) {
      const assets = await tx.$queryRaw<{ id: string; status: string; kind: string }[]>`
        SELECT "id", "status", "kind" FROM "Asset"
        WHERE "id" IN (${Prisma.join(assetIds)})
        ORDER BY "id" FOR UPDATE`;
      if (assets.length !== assetIds.length || assets.some(asset => asset.status !== "READY")) {
        throw new AppError("草稿中有素材已移除或仍在处理中。", 422);
      }
      if (assets.some(asset => coverIds.has(asset.id) && asset.kind !== "IMAGE")) {
        throw new AppError("视频封面必须是图片。", 422);
      }
    }

    if (accountIds.length) {
      const count = await tx.platformAccount.count({ where: { id: { in: accountIds } } });
      if (count !== accountIds.length) throw new AppError("草稿中有账号已移除。", 422);
    }
    await tx.contentAsset.deleteMany({ where: { contentId: id, assetId: { notIn: assetIds } } });
    if (assetIds.length) {
      await tx.contentAsset.createMany({ data: assetIds.map(assetId => ({ contentId: id, assetId })), skipDuplicates: true });
    }
    return { id, revision: revision + 1, updatedAt: updatedAt.toISOString() };
  });
}

export async function draftEditorResources(ownerId: string) {
  const [accounts, assets, presets, preference] = await Promise.all([
    db().platformAccount.findMany({
      where: { platform: { in: [...platformKeys] } },
      select: { id: true, name: true, platform: true, status: true, mode: true, language: true, expiresAt: true },
      orderBy: [{ platform: "asc" }, { name: "asc" }],
    }),
    db().asset.findMany({
      where: { status: "READY" },
      select: { id: true, filename: true, kind: true, thumbKey: true },
      orderBy: { createdAt: "desc" },
    }),
    listPresets(ownerId),
    db().preference.findUnique({ where: { id: "workspace" }, select: { reviewRequired: true } }),
  ]);
  const now = Date.now();
  return {
    accounts: accounts.map(({ expiresAt, platform, ...account }) => ({
      ...account, platform: platform as PlatformKey, expiresAt: expiresAt?.toISOString() ?? null,
      available: account.status === "ACTIVE" && (!expiresAt || +expiresAt > now),
    })),
    assets: assets.map(({ thumbKey, ...asset }) => ({ ...asset, hasThumbnail: Boolean(thumbKey) })),
    presets,
    reviewRequired: preference?.reviewRequired ?? false,
  };
}

export function listPresets(ownerId: string) {
  return db().platformPreset.findMany({
    where: { ownerId }, select: { id: true, name: true, accountIds: true }, orderBy: { name: "asc" },
  });
}

export async function savePreset(ownerId: string, { name, accountIds }: z.infer<typeof presetInputSchema>) {
  const valid = await db().platformAccount.count({ where: {
    id: { in: accountIds }, platform: { in: [...platformKeys] }, status: "ACTIVE",
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  } });
  if (valid !== accountIds.length) throw new AppError("部分账号当前不可用，请重新勾选。", 422);
  return db().platformPreset.upsert({
    where: { ownerId_name: { ownerId, name } },
    create: { ownerId, name, accountIds }, update: { accountIds },
    select: { id: true, name: true, accountIds: true },
  });
}
