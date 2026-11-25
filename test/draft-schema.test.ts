import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  draftAssetReferences, draftSchema, draftUpdateSchema, emptyDraft, resolveDraftCopy,
  restoreDraftCopy, updateDraftCopy,
} from "../src/lib/draft-schema";
import { formatBody } from "../src/lib/platforms";

test("per-platform edits freeze the entire selected language copy and restore inheritance", () => {
  const initial = updateDraftCopy(emptyDraft(), null, "ZH", { title: "通用初稿", body: "正文一", tags: ["发布"] });
  assert.equal(resolveDraftCopy(initial, "weibo", "EN"), undefined);
  const tailored = updateDraftCopy(initial, "weibo", "ZH", { title: "微博标题" });
  const changed = updateDraftCopy(tailored, null, "ZH", { body: "正文二", tags: [] });
  assert.deepEqual(resolveDraftCopy(changed, "weibo", "ZH"), { ...initial.versions.ZH, title: "微博标题" });
  assert.equal(resolveDraftCopy(changed, "wechat", "ZH")?.body, "正文二");
  const restored = restoreDraftCopy(changed, "weibo", "ZH");
  assert.deepEqual(restored.overrides, {});
  assert.equal(resolveDraftCopy(restored, "weibo", "ZH")?.body, "正文二");
});

test("cover and asset references include every language and platform-specific copy without duplicates", () => {
  const asset = randomUUID();
  const cover = randomUUID();
  const substitute = randomUUID();
  let draft = updateDraftCopy(emptyDraft(), null, "ZH", { assetIds: [asset], coverId: cover });
  draft = updateDraftCopy(draft, null, "JA", { assetIds: [asset, cover] });
  draft = updateDraftCopy(draft, "youtube", "JA", { assetIds: [substitute], coverId: cover });
  assert.deepEqual(draftAssetReferences(draft), { assetIds: [asset, cover, substitute].sort(), coverIds: new Set([cover]) });
  assert.deepEqual(draftAssetReferences(restoreDraftCopy(draft, "youtube", "JA")).assetIds, [asset, cover].sort());
});

test("draft schema validates revision, supported platforms, and unique account and asset selections", () => {
  const id = randomUUID();
  const draft = emptyDraft();
  assert.equal(draftUpdateSchema.safeParse({ revision: 0, draft }).success, true);
  assert.equal(draftUpdateSchema.safeParse({ revision: -1, draft }).success, false);
  assert.equal(draftSchema.safeParse({ ...draft, selections: [{ accountId: id }, { accountId: id, language: "ZH" }] }).success, false);
  assert.equal(draftSchema.safeParse({ ...draft, selections: [{ accountId: id, language: "DE" }] }).success, false);
  assert.equal(draftSchema.safeParse({ ...draft, overrides: { inventedPlatform: { ZH: draft.versions.ZH } } }).success, false);
  assert.equal(draftSchema.safeParse(updateDraftCopy(draft, null, "ZH", { assetIds: [id, id] })).success, false);
});

test("provider captions and editor counts include the same tags", () => {
  const copy = { title: "新品", body: "新品发布", tags: ["新品", "#公司"] };
  assert.equal(formatBody("bluesky", copy), "新品\n\n新品发布\n\n#新品 #公司");
  assert.equal(formatBody("youtube", copy), "新品发布");
});
