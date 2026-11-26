import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyDraft, updateDraftCopy } from "../../src/lib/draft-schema";
import { createDraft, deleteDraft, draftEditorResources, findDraft, listDrafts, listEditorAssets, listPresets, saveDraft, savePreset } from "../../src/server/drafts";
import { db } from "../../src/server/db";
import { AppError } from "../../src/server/errors";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://unconfigured");
if (process.env.APP_MODE !== "local" || !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname)) {
  throw new Error("Draft fixtures require APP_MODE=local and a local database");
}

const client = db();
const suffix = randomUUID();
const ownedIds = { users: [] as string[], assets: [] as string[], accounts: [] as string[], drafts: [] as string[] };
const appStatus = (status: number) => (error: unknown) => error instanceof AppError && error.status === status;

try {
  for (const name of ["owner", "other"]) {
    const user = await client.user.create({ data: {
      email: `${name}-${suffix}@example.test`, name: `测试 ${name}`, role: "EDITOR", passwordHash: "test", totpSecret: "test",
    } });
    ownedIds.users.push(user.id);
  }
  const [ownerId, otherId] = ownedIds.users;
  for (const kind of ["IMAGE", "VIDEO"] as const) {
    const asset = await client.asset.create({ data: {
      objectKey: `draft-test/${suffix}/${kind}`, mime: kind === "IMAGE" ? "image/png" : "video/mp4",
      filename: `${suffix} ${kind}`, bytes: 10n, kind, status: "READY", uploaderId: ownerId,
    } });
    ownedIds.assets.push(asset.id);
  }
  const [imageId, videoId] = ownedIds.assets;
  const account = await client.platformAccount.create({ data: {
    platform: "bluesky", externalId: suffix, mode: "MOCK", name: "测试账号",
  } });
  ownedIds.accounts.push(account.id);

  const { id } = await createDraft(ownerId);
  ownedIds.drafts.push(id);
  const original = updateDraftCopy(emptyDraft(), null, "ZH", { title: "原始草稿", coverId: imageId, assetIds: [videoId] });
  const attached = { ...original, selections: [{ accountId: account.id }] };
  assert.equal((await saveDraft(ownerId, id, { draft: attached, revision: 0 })).revision, 1);
  assert.equal((await saveDraft(ownerId, id, { draft: attached, revision: 0 })).revision, 1);
  assert.equal(await findDraft(otherId, id), null);
  await assert.rejects(saveDraft(otherId, id, { draft: attached, revision: 1 }), appStatus(404));
  await assert.rejects(saveDraft(ownerId, id, { draft: emptyDraft(), revision: 0 }), appStatus(409));
  assert.equal(await client.contentAsset.count({ where: { contentId: id } }), 2);

  const invalidCover = updateDraftCopy(attached, null, "ZH", { title: "不应保存", coverId: videoId });
  await assert.rejects(saveDraft(ownerId, id, { draft: invalidCover, revision: 1 }), appStatus(422));
  assert.equal((await findDraft(ownerId, id))?.draft.versions.ZH.title, "原始草稿");
  assert.equal(await client.contentAsset.count({ where: { contentId: id } }), 2);

  const changes = ["并发编辑甲", "并发编辑乙"].map(title => updateDraftCopy(emptyDraft(), null, "ZH", { title }));
  const results = await Promise.allSettled(changes.map(draft => saveDraft(ownerId, id, { draft, revision: 1 })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const conflict = results.find(result => result.status === "rejected");
  assert.ok(conflict?.status === "rejected" && appStatus(409)(conflict.reason));
  assert.equal(await client.contentAsset.count({ where: { contentId: id } }), 0);

  const removable = await createDraft(ownerId);
  ownedIds.drafts.push(removable.id);
  await saveDraft(ownerId, removable.id, { draft: attached, revision: 0 });
  const resources = await draftEditorResources(ownerId, attached);
  assert.deepEqual(resources.assets.map(asset => asset.id).sort(), [...ownedIds.assets].sort());
  assert.equal((await draftEditorResources(ownerId, emptyDraft())).assets.length, 0);
  await assert.rejects(deleteDraft(otherId, removable.id, 1), appStatus(404));
  await assert.rejects(deleteDraft(ownerId, removable.id, 0), appStatus(409));
  assert.equal(await client.contentAsset.count({ where: { contentId: removable.id } }), 2);
  await Promise.all([deleteDraft(ownerId, removable.id, 1), deleteDraft(ownerId, removable.id, 1)]);
  assert.equal(await findDraft(ownerId, removable.id), null);
  assert.equal(await client.contentAsset.count({ where: { contentId: removable.id } }), 0);
  assert.equal(await client.auditLog.count({ where: { action: "draft.delete", objectId: removable.id } }), 1);

  const returned = await createDraft(ownerId);
  ownedIds.drafts.push(returned.id);
  await client.content.update({ where: { id: returned.id }, data: {
    status: "RETURNED", reviewNote: "测试退回", submittedAt: new Date(),
    reviews: { create: { reviewerId: otherId, approved: false, note: "测试退回" } },
    tasks: { create: { publisherId: ownerId, accountId: account.id, mode: "MOCK", platform: account.platform,
      language: "ZH", status: "CANCELLED", payload: {}, runAt: new Date(), errorCode: "review_returned" } },
  } });
  await deleteDraft(ownerId, returned.id, 0);
  const history = await client.content.findUniqueOrThrow({ where: { id: returned.id }, include: { tasks: true, reviews: true } });
  assert.equal(history.status, "DISCARDED");
  assert.equal(history.tasks[0].errorCode, "review_returned");
  assert.equal(history.reviews[0].note, "测试退回");

  await client.content.update({ where: { id }, data: { status: "SUBMITTED" } });
  await assert.rejects(deleteDraft(ownerId, id, 2), appStatus(409));
  for (let index = 0; index < 25; index++) {
    ownedIds.drafts.push((await createDraft(ownerId)).id);
    const extra = await client.asset.create({ data: {
      objectKey: `draft-test/${suffix}/${index}`, mime: "video/mp4", filename: `${suffix} video ${index}`,
      bytes: 10n, kind: "VIDEO", status: "READY", uploaderId: ownerId,
    } });
    ownedIds.assets.push(extra.id);
  }
  const draftPages = await Promise.all([listDrafts(ownerId, 1), listDrafts(ownerId, 2)]);
  assert.deepEqual(draftPages.map(page => [page.drafts.length, page.hasMore]), [[24, true], [1, false]]);
  assert.equal(new Set(draftPages.flatMap(page => page.drafts.map(draft => draft.id))).size, 25);
  const assetPages = await Promise.all([listEditorAssets(1, suffix, false), listEditorAssets(2, suffix, false)]);
  assert.deepEqual(assetPages.map(page => [page.assets.length, page.hasMore]), [[24, true], [3, false]]);
  assert.equal(new Set(assetPages.flatMap(page => page.assets.map(asset => asset.id))).size, 27);
  assert.deepEqual((await listEditorAssets(1, suffix, true)).assets.map(asset => asset.id), [imageId]);

  const preset = await savePreset(ownerId, { name: "测试组合", accountIds: [account.id] });
  assert.equal((await listPresets(ownerId))[0]?.id, preset.id);
  assert.deepEqual(await listPresets(otherId), []);
  await client.platformAccount.update({ where: { id: account.id }, data: { status: "DISABLED" } });
  await assert.rejects(savePreset(ownerId, { name: "停用组合", accountIds: [account.id] }), appStatus(422));

  console.info("通过：草稿所有权、版本竞争、删除与审计、素材引用回滚、分页和组合隔离。");
} finally {
  await client.platformPreset.deleteMany({ where: { ownerId: { in: ownedIds.users } } });
  await client.review.deleteMany({ where: { contentId: { in: ownedIds.drafts } } });
  await client.publishTask.deleteMany({ where: { contentId: { in: ownedIds.drafts } } });
  await client.content.deleteMany({ where: { id: { in: ownedIds.drafts } } });
  await client.asset.deleteMany({ where: { id: { in: ownedIds.assets } } });
  await client.platformAccount.deleteMany({ where: { id: { in: ownedIds.accounts } } });
  // The discard audit row retains its actor and is append-only.
  await client.user.updateMany({ where: { id: { in: ownedIds.users } }, data: { active: false } });
  await client.$disconnect();
}
