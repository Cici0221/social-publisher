import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyDraft, updateDraftCopy } from "../../src/lib/draft-schema";
import { createDraft, findDraft, listPresets, saveDraft, savePreset } from "../../src/server/drafts";
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
      filename: kind, bytes: 10n, kind, status: "READY", uploaderId: ownerId,
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

  const preset = await savePreset(ownerId, { name: "测试组合", accountIds: [account.id] });
  assert.equal((await listPresets(ownerId))[0]?.id, preset.id);
  assert.deepEqual(await listPresets(otherId), []);
  await client.platformAccount.update({ where: { id: account.id }, data: { status: "DISABLED" } });
  await assert.rejects(savePreset(ownerId, { name: "停用组合", accountIds: [account.id] }), appStatus(422));

  console.info("通过：草稿所有权、版本竞争、重试幂等、素材引用回滚和组合隔离。");
} finally {
  await client.platformPreset.deleteMany({ where: { ownerId: { in: ownedIds.users } } });
  await client.content.deleteMany({ where: { id: { in: ownedIds.drafts } } });
  await client.asset.deleteMany({ where: { id: { in: ownedIds.assets } } });
  await client.platformAccount.deleteMany({ where: { id: { in: ownedIds.accounts } } });
  await client.user.deleteMany({ where: { id: { in: ownedIds.users } } });
  await client.$disconnect();
}
