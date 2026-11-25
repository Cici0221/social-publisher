import assert from "node:assert/strict";
import { test } from "node:test";
import { TextWriter, Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { isManualPlatform, manualBackend, manualUrl } from "../src/platforms/manual-policy";
import { wechat } from "../src/platforms/providers/wechat";
import { xiaohongshu } from "../src/platforms/providers/xiaohongshu";
import type { AdapterContext } from "../src/platforms/types";
import { manualPackageFileName, manualPackageStream } from "../src/server/manual-zip";

test("manual platform URLs accept only official HTTPS hosts", () => {
  assert.equal(isManualPlatform("xiaohongshu"), true);
  assert.equal(isManualPlatform("youtube"), false);
  assert.equal(manualBackend("xiaohongshu"), "https://creator.xiaohongshu.com/");
  assert.equal(manualBackend("wechat"), "https://channels.weixin.qq.com/");
  assert.equal(manualBackend("wechat", "https://channels.weixin.qq.com/platform"), "https://channels.weixin.qq.com/platform");
  for (const invalid of [
    "https://channels.weixin.qq.com.evil.test/", "https://evil.test@channels.weixin.qq.com/", "https://channels.weixin.qq.com:8443/",
    "https://channels.weixin.qq.com/?return=https://evil.test/", "http://channels.weixin.qq.com/", "javascript:alert(1)",
  ]) assert.equal(manualBackend("wechat", invalid), null);
  assert.equal(manualUrl("xiaohongshu", "https://www.xiaohongshu.com/explore/42", "post"), "https://www.xiaohongshu.com/explore/42");
  assert.equal(manualUrl("xiaohongshu", "https://xhslink.com/a/42", "post"), "https://xhslink.com/a/42");
  assert.equal(manualUrl("wechat", "https://weixin.qq.com/sph/42", "post"), "https://weixin.qq.com/sph/42");
  assert.equal(manualUrl("wechat", "https://channels.weixin.qq.com/platform", "post"), null);
  assert.equal(manualUrl("wechat", "https://www.xiaohongshu.com/explore/42", "post"), null);
});

test("manual adapters expose delivery without provider networking", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network call"); });
  for (const adapter of [xiaohongshu, wechat]) {
    const noCredentials = {} as AdapterContext;
    assert.equal(adapter.availability().available, true);
    assert.equal(adapter.authorize, undefined);
    assert.deepEqual(await adapter.uploadMedia(noCredentials), { kind: "ready" });
    assert.deepEqual(await adapter.publish(noCredentials), { kind: "manual" });
    assert.deepEqual(await adapter.queryStatus(noCredentials), { kind: "manual" });
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("manual ZIP writes safe filenames and readable streamed assets in order", async () => {
  const order: string[] = [];
  const stream = manualPackageStream("标题\n\n正文", [
    { filename: "../夹\\共享.png", cover: false, stream: async () => { order.push("media"); return new Blob(["海报"]).stream(); } },
    { filename: "../夹\\共享.png", cover: true, stream: async () => { order.push("cover"); return new Blob(["封面"]).stream(); } },
  ]);
  assert.deepEqual(order, []);
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  assert.deepEqual(order, ["media", "cover"]);
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await reader.getEntries();
    assert.deepEqual(entries.map(entry => entry.filename), ["发布文案.txt", "素材/01-_夹_共享.png", "封面/02-_夹_共享.png"]);
    const contents = await Promise.all(entries.map(entry => entry.directory ? "" : entry.getData(new TextWriter())));
    assert.deepEqual(contents, ["标题\n\n正文", "海报", "封面"]);
  } finally {
    await reader.close();
  }
  assert.match(manualPackageFileName(`${"图".repeat(170)}.png`, 0, true), /\.png$/);
});

test("manual ZIP aborts a missing asset download instead of finishing an incomplete package", async () => {
  const stream = manualPackageStream("文案", [{
    filename: "missing.jpg", cover: false, stream: async () => { throw new Error("asset missing"); },
  }]);
  await assert.rejects(new Response(stream).arrayBuffer(), /素材包生成中断/);
});
