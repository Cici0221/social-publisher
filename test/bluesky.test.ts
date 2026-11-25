import assert from "node:assert/strict";
import test from "node:test";
import { bluesky, blueskyFacets, blueskyRecordKey } from "../src/platforms/providers/bluesky";
import type { AdapterContext } from "../src/platforms/types";
import { measureCopy } from "../src/lib/platforms";

const input = "😀 中文 https://example.test/test， #新品";

function fixture(): AdapterContext {
  return {
    taskId: "4f54e143-6434-438f-b8a3-ee437131a15f", createdAt: new Date("2026-11-01T10:00:00Z"),
    payload: { title: "", body: input, coverId: null, options: {}, language: "ZH", tags: [], assetIds: [] },
    credentials: { accountName: "company.bsky.social", externalId: "did:plc:official", accessToken: "fixture-only" },
    media: [], state: {},
    async checkpoint(value) { this.state = value; },
    async beginSubmission() {},
  };
}

test("Bluesky uses UTF-8 facets and stable within-task record keys", () => {
  const facets = blueskyFacets(input);
  const bytes = Buffer.from(input);
  assert.deepEqual(facets.map(facet => bytes.subarray(facet.index.byteStart, facet.index.byteEnd).toString()), ["https://example.test/test", "#新品"]);
  assert.match(blueskyRecordKey("same", new Date("2026-11-01")), /^[234567a-j][234567a-z]{12}$/);
  assert.equal(blueskyRecordKey("same", new Date("2026-11-01")), blueskyRecordKey("same", new Date("2026-11-01")));
  assert.equal(measureCopy("bluesky", "👨‍👩‍👧‍👦"), 1);
});

test("Bluesky creates an official record and reconciles that same record after losing the response", async t => {
  const context = fixture();
  let submitted = false;
  let posted: { rkey: string; record: { text: string; createdAt: string } } | undefined;
  context.beginSubmission = async () => { submitted = true; };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url);
    assert.equal(path.hostname, "bsky.social");
    if (path.pathname.endsWith("createRecord")) {
      assert.ok(submitted, "checkpoint must precede final mutation");
      posted = JSON.parse(String(init.body));
      return Response.json({ uri: "at://did:plc:official/app.bsky.feed.post/" + posted!.rkey });
    }
    if (path.pathname.endsWith("getRecord")) {
      assert.equal(path.searchParams.get("rkey"), posted?.rkey);
      return Response.json({ uri: "at://did:plc:official/app.bsky.feed.post/" + posted!.rkey, value: posted!.record });
    }
    throw new Error("unexpected host");
  });
  assert.equal((await bluesky.uploadMedia(context)).kind, "ready");
  const sent = await bluesky.publish(context);
  assert.equal(sent.kind, "success");
  assert.equal(posted?.record.text, input);
  assert.deepEqual(await bluesky.queryStatus(context), sent);
});

test("Bluesky sends video once and reuses the processing checkpoint", async t => {
  const context = fixture();
  const bytes = new Uint8Array([1, 8, 3]);
  context.media = [{
    id: "fixture-video", filename: "preview.mp4", mime: "video/mp4", bytes: bytes.length,
    kind: "VIDEO", width: 1080, height: 1920, duration: 5,
    async read() { return Buffer.from(bytes); },
    async stream() { return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }); },
    async url() { throw new Error("Bluesky uploads from a signed service session rather than pulling a media URL"); },
  }];
  let uploads = 0;
  const blob = { $type: "blob", ref: { $link: "mock-blob-id" }, mimeType: "video/mp4", size: bytes.length };
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    if (url.pathname.endsWith("getServiceAuth")) {
      assert.equal(url.hostname, "bsky.social");
      assert.equal(url.searchParams.get("aud"), "did:web:bsky.social");
      assert.equal(url.searchParams.get("lxm"), "com.atproto.repo.uploadBlob");
      return Response.json({ token: "media-service-fixture" });
    }
    if (url.pathname.endsWith("uploadVideo")) {
      uploads++;
      assert.equal(url.hostname, "video.bsky.app");
      assert.equal(url.searchParams.get("did"), context.credentials.externalId);
      assert.equal(headers.get("Authorization"), "Bearer media-service-fixture");
      assert.deepEqual(new Uint8Array(await new Response(init.body).arrayBuffer()), bytes);
      return Response.json({ jobId: "fixture-job", state: "JOB_STATE_ENCODING" });
    }
    if (url.pathname.endsWith("getJobStatus")) {
      assert.equal(url.searchParams.get("jobId"), "fixture-job");
      return Response.json({ jobStatus: { jobId: "fixture-job", state: "JOB_STATE_COMPLETED", blob } });
    }
    if (url.pathname.endsWith("createRecord")) {
      const request = JSON.parse(String(init.body));
      assert.deepEqual(request.record.embed, { $type: "app.bsky.embed.video", video: blob, alt: "", aspectRatio: { width: 1080, height: 1920 } });
      return Response.json({ uri: "at://did:plc:official/app.bsky.feed.post/" + request.rkey });
    }
    throw new Error("unexpected API call");
  });
  assert.equal((await bluesky.uploadMedia(context)).kind, "pending");
  assert.equal((await bluesky.uploadMedia(context)).kind, "ready");
  assert.equal((await bluesky.uploadMedia(context)).kind, "ready");
  assert.equal((await bluesky.publish(context)).kind, "success");
  assert.equal(uploads, 1);
});
