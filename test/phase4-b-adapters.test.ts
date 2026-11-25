import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { bilibiliAdapter } from "../src/platforms/providers/bilibili";
import { douyinAdapter } from "../src/platforms/providers/douyin";
import { kuaishouAdapter } from "../src/platforms/providers/kuaishou";
import { weiboAdapter } from "../src/platforms/providers/weibo";
import type { AdapterContext, Media } from "../src/platforms/types";
import { ProviderError } from "../src/platforms/types";

function media(kind: "IMAGE" | "VIDEO"): Media {
  const blob = Buffer.from(kind === "IMAGE" ? "test-image" : "test-mp4");
  return {
    id: kind, filename: kind === "IMAGE" ? "test.jpg" : "test.mp4",
    mime: kind === "IMAGE" ? "image/jpeg" : "video/mp4", bytes: blob.length, kind,
    width: 1280, height: 720, duration: kind === "VIDEO" ? 15 : null,
    read: async (start = 0, end = blob.length - 1) => blob.subarray(start, end + 1),
    stream: async (start = 0, end = blob.length - 1) => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(blob.subarray(start, end + 1));
        controller.close();
      },
    }),
    url: async () => "https://unused.invalid/",
  };
}

function fakeContext(kind: "IMAGE" | "VIDEO", events: string[]) {
  const context: AdapterContext = {
    taskId: "task", createdAt: new Date(), state: {},
    payload: { title: "标题", body: "文案", tags: ["话题"], language: "ZH", assetIds: ["1"],
      coverId: null, options: { consent: true, copyright: "1", categoryId: 25 } },
    credentials: { externalId: "test-account", accountName: "账号", accessToken: "fake-access" },
    media: [media(kind)],
    checkpoint: async value => { context.state = value; events.push("checkpoint"); },
    beginSubmission: async () => { events.push("begin"); },
  };
  return context;
}

function json(data: object) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

test("哔哩哔哩签名、裸流上传和可见审核状态", async t => {
  process.env.BILIBILI_CLIENT_ID = "test-client";
  process.env.BILIBILI_CLIENT_SECRET = "test-secret";
  const events: string[] = [];
  const context = fakeContext("VIDEO", events);
  let state = -1;
  const fetcher = t.mock.method(globalThis, "fetch", async (raw: string | URL, init: RequestInit) => {
    const url = new URL(raw);
    const headers = new Headers(init.headers);
    if (url.hostname === "member.bilibili.com") {
      const signature = Array.from(headers.entries()).filter(([key]) => key.startsWith("x-bili-"))
        .sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join("\n");
      assert.equal(headers.get("Authorization"), createHmac("sha256", "test-secret").update(signature).digest("hex"));
      assert.equal(headers.get("x-bili-content-md5"),
        createHash("md5").update(typeof init.body === "string" ? init.body : "").digest("hex"));
      assert.equal(headers.get("access-token"), "fake-access");
    }
    switch (url.pathname) {
      case "/arcopen/fn/archive/video/init":
        assert.deepEqual(JSON.parse(String(init.body)), { name: "test.mp4", utype: "1" });
        return json({ code: 0, data: { upload_token: "video-token" } });
      case "/video/v2/upload":
        assert.equal(headers.get("Content-Type"), "application/octet-stream");
        assert.equal(headers.has("access-token"), false);
        assert.equal(url.searchParams.get("upload_token"), "video-token");
        assert.equal(await new Response(init.body).text(), "test-mp4");
        return json({ code: 0 });
      case "/arcopen/fn/archive/add-by-utoken":
        events.push("create");
        assert.equal(url.searchParams.get("upload_token"), "video-token");
        assert.deepEqual(JSON.parse(String(init.body)), { title: "标题", desc: "文案", tag: "话题", tid: 25, copyright: 1 });
        return json({ code: 0, data: { resource_id: "BV1234567890" } });
      case "/arcopen/fn/archive/view":
        assert.equal(url.searchParams.get("resource_id"), "BV1234567890");
        return json({ code: 0, data: { addit_info: { state, reject_reason: "" } } });
      default:
        assert.fail("unexpected route " + url.pathname);
    }
  });

  assert.equal((await bilibiliAdapter.uploadMedia(context)).kind, "ready");
  assert.equal((await bilibiliAdapter.publish(context)).kind, "pending");
  assert.ok(events.indexOf("begin") < events.indexOf("create"));
  assert.equal((await bilibiliAdapter.publish(context)).kind, "pending");
  assert.equal(events.filter(item => item === "create").length, 1);
  assert.equal((await bilibiliAdapter.queryStatus(context)).kind, "pending");
  state = 0;
  assert.deepEqual(await bilibiliAdapter.queryStatus(context), {
    kind: "success", externalId: "BV1234567890", url: "https://www.bilibili.com/video/BV1234567890",
  });
  assert.equal(fetcher.mock.callCount(), 5);
});

test("抖音图文需要同意，只提交一次，未确认审核结果不报成功", async t => {
  const events: string[] = [];
  const context = fakeContext("IMAGE", events);
  context.payload.body = "标题\n\n文案\n\n#话题";
  t.mock.method(globalThis, "fetch", async (raw: string | URL, init: RequestInit) => {
    const url = new URL(raw);
    assert.equal(url.hostname, "open.douyin.com");
    assert.equal(url.searchParams.get("open_id"), "test-account");
    assert.equal(new Headers(init.headers).get("access-token"), "fake-access");
    if (url.pathname.endsWith("/upload_image/")) {
      assert.equal(await ((init.body as FormData).get("image") as File).text(), "test-image");
      return json({ data: { error_code: 0, image: { image_id: "image-id" } } });
    }
    assert.ok(url.pathname.endsWith("/create_image_text/"));
    events.push("create");
    assert.deepEqual(JSON.parse(String(init.body)), { text: "标题\n\n文案\n\n#话题", image_list: ["image-id"] });
    return json({ data: { error_code: 0, item_id: "pending-item" }, extra: { error_code: 0 } });
  });

  context.payload.options.consent = false;
  await assert.rejects(douyinAdapter.uploadMedia(context), (error: ProviderError) => error.code === "douyin_consent");
  context.payload.options.consent = true;
  assert.equal((await douyinAdapter.uploadMedia(context)).kind, "ready");
  assert.equal((await douyinAdapter.publish(context)).kind, "pending");
  assert.ok(events.indexOf("begin") < events.indexOf("create"));
  assert.equal((await douyinAdapter.publish(context)).kind, "pending");
  assert.equal(events.filter(item => item === "create").length, 1);
  assert.equal((await douyinAdapter.queryStatus(context)).kind, "unknown");
});

test("快手未确认 HTTPS 网关以及微博没有可信来源时不调用发布 API", async t => {
  const context = fakeContext("VIDEO", []);
  context.payload.options.operatorIp = "198.51.100.1";
  const request = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected upstream"); });
  assert.equal(kuaishouAdapter.availability().available, false);
  await assert.rejects(kuaishouAdapter.uploadMedia(context), (error: ProviderError) => error.code === "kuaishou_upload_tls");
  assert.equal(weiboAdapter.availability().available, false);
  await assert.rejects(weiboAdapter.publish(context), (error: ProviderError) => error.code === "weibo_operator");
  assert.equal(request.mock.callCount(), 0);
});
