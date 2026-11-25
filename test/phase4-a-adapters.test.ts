import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { facebook } from "../src/platforms/providers/facebook";
import { instagram } from "../src/platforms/providers/instagram";
import { linkedin } from "../src/platforms/providers/linkedin";
import { threads } from "../src/platforms/providers/threads";
import { youtube } from "../src/platforms/providers/youtube";
import { ProviderError, type AdapterContext, type Media } from "../src/platforms/types";

function media(id: string, kind: Media["kind"], value = "abcd"): Media {
  const data = Buffer.from(value);
  function range(start?: number, end?: number) {
    return data.subarray(start ?? 0, end === undefined ? undefined : end + 1);
  }
  return {
    id, kind, filename: id + (kind === "VIDEO" ? ".mp4" : ".jpg"), mime: kind === "VIDEO" ? "video/mp4" : "image/jpeg",
    bytes: data.byteLength, width: 500, height: 500, duration: kind === "VIDEO" ? 30 : null,
    read: async (start, end) => range(start, end),
    stream: async (start, end) => new ReadableStream({
      start(controller) { controller.enqueue(range(start, end)); controller.close(); },
    }),
    url: async () => "https://media.example.com/" + id + "?signed=demo",
  };
}

function makeContext(files: Media[] = [], cover?: Media) {
  let submissionCount = 0;
  const context: AdapterContext = {
    taskId: "task-1", createdAt: new Date(), media: files, cover, state: {},
    credentials: { externalId: "111", accountName: "Company", accessToken: "fixture-token" },
    payload: {
      title: "公司公告", body: "公司公告\n\n内容\n\n#消息",
      tags: ["消息"], language: "ZH", assetIds: files.map(file => file.id), coverId: cover?.id ?? null,
      options: { privacy: "unlisted" },
    },
    beginSubmission: async () => { submissionCount += 1; },
    checkpoint: async state => { context.state = structuredClone(state); },
  };
  return { context, submissions: () => submissionCount };
}

function mockFetch(t: TestContext, request: (url: URL, init: RequestInit) => Promise<Response> | Response) {
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => request(new URL(url), init));
}

test("YouTube resumes the same upload after a final write loses its receipt", async t => {
  const { context, submissions } = makeContext([media("video", "VIDEO")], media("cover", "IMAGE"));
  let resumableCreates = 0;
  let finalWrites = 0;
  let thumbnails = 0;
  mockFetch(t, async (url, options) => {
    const headers = new Headers(options.headers);
    if (url.pathname === "/upload/youtube/v3/videos" && options.method === "POST") {
      resumableCreates += 1;
      const body = JSON.parse(String(options.body));
      assert.equal(body.status.privacyStatus, "unlisted");
      assert.equal(body.snippet.description, context.payload.body);
      return new Response(null, { headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=same" } });
    }
    if (url.searchParams.has("upload_id")) {
      const range = headers.get("Content-Range");
      if (range === "bytes */4") return new Response(null, { status: 308, headers: { range: "bytes=0-1" } });
      finalWrites += 1;
      if (finalWrites === 1) {
        assert.equal(range, "bytes 0-3/4");
        throw new TypeError("simulated connection loss");
      }
      assert.equal(range, "bytes 2-3/4");
      assert.equal(await new Response(options.body).text(), "cd");
      return Response.json({ id: "video123" }, { status: 201 });
    }
    if (url.pathname === "/youtube/v3/videos") {
      return Response.json({ items: [{ id: "video123", processingDetails: { processingStatus: "succeeded" } }] });
    }
    if (url.pathname.endsWith("/thumbnails/set")) {
      thumbnails += 1;
      assert.equal(await new Response(options.body).text(), "abcd");
      return Response.json({});
    }
    throw new Error("unexpected request");
  });

  assert.deepEqual(await youtube.uploadMedia(context), { kind: "ready" });
  await assert.rejects(youtube.publish(context), error => error instanceof ProviderError && error.code === "network");
  assert.deepEqual(await youtube.queryStatus(context), { kind: "safe-to-resume" });
  assert.equal(context.state.uploadedBytes, 2);
  const outcome = await youtube.publish(context);
  assert.equal(outcome.kind, "pending");
  if (outcome.kind === "pending") assert.equal(outcome.externalId, "video123");
  assert.deepEqual(await youtube.queryStatus(context), { kind: "success", externalId: "video123", url: "https://www.youtube.com/watch?v=video123" });
  await youtube.queryStatus(context);
  assert.equal(submissions(), 2);
  assert.equal(resumableCreates, 1);
  assert.equal(thumbnails, 1);
});

test("Facebook checkpoints unpublished images before submitting the one Page post", async t => {
  const { context, submissions } = makeContext([media("photo1", "IMAGE"), media("photo2", "IMAGE")]);
  let photos = 0;
  mockFetch(t, async (url, request) => {
    if (url.pathname.endsWith("/photos")) {
      assert.equal(submissions(), 0);
      assert.match(await new Response(request.body).text(), /name="published"\r\n\r\nfalse/);
      photos += 1;
      return Response.json({ id: String(225 + photos) });
    }
    if (url.pathname.endsWith("/feed")) {
      assert.equal(submissions(), 1);
      const body = request.body as URLSearchParams;
      assert.equal(body.get("message"), context.payload.body);
      assert.equal(body.get("attached_media[0]"), '{"media_fbid":"226"}');
      assert.equal(body.get("attached_media[1]"), '{"media_fbid":"227"}');
      return Response.json({ id: "111_228" });
    }
    if (url.pathname.endsWith("/111_228")) return Response.json({ permalink_url: "https://www.facebook.com/company/posts/228" });
    throw new Error("unexpected request");
  });

  assert.deepEqual(await facebook.uploadMedia(context), { kind: "ready" });
  assert.deepEqual(await facebook.uploadMedia(context), { kind: "ready" });
  assert.equal(photos, 2);
  assert.equal((await facebook.publish(context)).kind, "pending");
  assert.deepEqual(await facebook.queryStatus(context), { kind: "success", externalId: "111_228", url: "https://www.facebook.com/company/posts/228" });
});

test("Instagram resolves an ambiguous publish using the previously saved container", async t => {
  const { context, submissions } = makeContext([media("reel", "VIDEO")], media("cover", "IMAGE"));
  let containers = 0;
  let state = "IN_PROGRESS";
  mockFetch(t, (url, request) => {
    if (url.pathname.endsWith("/111/media")) {
      containers += 1;
      const body = request.body as URLSearchParams;
      assert.equal(body.get("media_type"), "REELS");
      assert.equal(body.get("caption"), context.payload.body);
      assert.equal(body.get("cover_url"), "https://media.example.com/cover?signed=demo");
      return Response.json({ id: "223" });
    }
    if (url.pathname.endsWith("/223")) return Response.json({ status_code: state });
    if (url.pathname.endsWith("/media_publish")) {
      assert.equal(submissions(), 1);
      assert.equal((request.body as URLSearchParams).get("creation_id"), "223");
      state = "PUBLISHED";
      throw new TypeError("simulated connection loss");
    }
    throw new Error("unexpected request");
  });

  assert.equal((await instagram.uploadMedia(context)).kind, "pending");
  state = "FINISHED";
  assert.deepEqual(await instagram.uploadMedia(context), { kind: "ready" });
  await assert.rejects(instagram.publish(context), error => error instanceof ProviderError && error.code === "network");
  assert.deepEqual(await instagram.queryStatus(context), { kind: "success", externalId: "223" });
  assert.equal(containers, 1);
  assert.equal(submissions(), 1);
});

test("Threads waits before publishing and reads the returned media permalink", async t => {
  const { context, submissions } = makeContext();
  let nextCalls = 0;
  mockFetch(t, (url, request) => {
    assert.equal(url.hostname, "graph.threads.com");
    nextCalls += 1;
    if (url.pathname.endsWith("/111/threads")) {
      const body = request.body as URLSearchParams;
      assert.equal(body.get("media_type"), "TEXT");
      assert.equal(body.get("text"), context.payload.body);
      assert.equal(body.has("auto_publish_text"), false);
      return Response.json({ id: "331" });
    }
    if (url.pathname.endsWith("/331")) return Response.json({ status: "FINISHED" });
    if (url.pathname.endsWith("/threads_publish")) {
      assert.equal(submissions(), 1);
      assert.equal((request.body as URLSearchParams).get("creation_id"), "331");
      return Response.json({ id: "332" });
    }
    if (url.pathname.endsWith("/332")) return Response.json({ permalink: "https://www.threads.com/@company/post/ABC" });
    throw new Error("unexpected request");
  });

  assert.deepEqual(await threads.uploadMedia(context), { kind: "pending", pollInMs: 30_000 });
  assert.equal((await threads.uploadMedia(context)).kind, "pending");
  assert.equal(nextCalls, 1);
  context.state.readyAt = Date.now() - 1;
  assert.deepEqual(await threads.uploadMedia(context), { kind: "ready" });
  assert.equal((await threads.publish(context)).kind, "pending");
  assert.deepEqual(await threads.queryStatus(context), { kind: "success", externalId: "332", url: "https://www.threads.com/@company/post/ABC" });
});

test("LinkedIn uploads exact byte ranges, finalizes media, then creates one company post", async t => {
  const { context, submissions } = makeContext([media("video", "VIDEO")], media("cover", "IMAGE"));
  const id = "urn:li:video:movie";
  let finalized = false;
  let postRequests = 0;
  const chunks: string[] = [];
  mockFetch(t, async (url, request) => {
    if (url.hostname === "www.linkedin.com") {
      assert.equal(request.method, "PUT");
      const headers = new Headers(request.headers);
      assert.equal(headers.has("Authorization"), false);
      const chunk = await new Response(request.body).text();
      if (url.pathname.endsWith("/cover")) assert.equal(headers.get("media-type-family"), "STILLIMAGE");
      chunks.push(chunk);
      return new Response(null, { headers: { etag: '"' + chunk + '"' } });
    }
    assert.equal(new Headers(request.headers).get("X-Restli-Protocol-Version"), "2.0.0");
    if (url.pathname.endsWith("/rest/videos") && url.searchParams.get("action") === "initializeUpload") {
      return Response.json({ value: {
        video: id, uploadToken: "upload-ticket", thumbnailUploadUrl: "https://www.linkedin.com/dms-uploads/cover",
        uploadInstructions: [
          { uploadUrl: "https://www.linkedin.com/dms-uploads/1", firstByte: 0, lastByte: 1 },
          { uploadUrl: "https://www.linkedin.com/dms-uploads/2", firstByte: 2, lastByte: 3 },
        ],
      } });
    }
    if (url.pathname.endsWith("/rest/videos") && url.searchParams.get("action") === "finalizeUpload") {
      const body = JSON.parse(String(request.body));
      assert.equal(body.finalizeUploadRequest.video, id);
      assert.deepEqual(body.finalizeUploadRequest.uploadedPartIds, ["ab", "cd"]);
      finalized = true;
      return new Response(null, { status: 200 });
    }
    if (decodeURIComponent(url.pathname).endsWith("/" + id)) {
      return Response.json({ status: finalized ? "AVAILABLE" : "WAITING_UPLOAD" });
    }
    if (url.pathname.endsWith("/rest/posts")) {
      postRequests += 1;
      assert.equal(submissions(), 1);
      const body = JSON.parse(String(request.body));
      assert.equal(body.author, "urn:li:organization:111");
      assert.equal(body.commentary, context.payload.body);
      assert.equal(body.content.media.id, id);
      return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:ugcPost:44" } });
    }
    if (decodeURIComponent(url.pathname).endsWith("/urn:li:ugcPost:44")) return Response.json({ lifecycleState: "PUBLISHED" });
    throw new Error("unexpected request");
  });

  assert.equal((await linkedin.uploadMedia(context)).kind, "pending");
  assert.deepEqual(await linkedin.uploadMedia(context), { kind: "ready" });
  assert.deepEqual(chunks, ["ab", "cd", "abcd"]);
  assert.equal((await linkedin.publish(context)).kind, "pending");
  assert.deepEqual(await linkedin.queryStatus(context), {
    kind: "success", externalId: "urn:li:ugcPost:44", url: "https://www.linkedin.com/feed/update/urn:li:ugcPost:44/",
  });
  await linkedin.publish(context);
  assert.equal(postRequests, 1);
});

test("Facebook and LinkedIn do not submit again when a final receipt is unavailable", async () => {
  const { context, submissions } = makeContext();
  assert.deepEqual(await facebook.queryStatus(context), { kind: "unknown" });
  assert.deepEqual(await linkedin.queryStatus(context), { kind: "unknown" });
  assert.equal(submissions(), 0);
});

test("Meta and LinkedIn authorize only their required organization or publishing scopes", t => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  for (const prefix of ["YOUTUBE", "FACEBOOK", "INSTAGRAM", "THREADS", "LINKEDIN"]) {
    process.env[prefix + "_CLIENT_ID"] = "test-id";
    process.env[prefix + "_CLIENT_SECRET"] = "test-secret";
  }
  const data = { redirectUri: "https://publisher.example.com/auth/callback", state: "nonce", verifier: "owned-verifier" };
  const checks = [
    { adapter: youtube, host: "accounts.google.com", scopes: ["https://www.googleapis.com/auth/youtube.upload"] },
    { adapter: facebook, host: "www.facebook.com", scopes: ["pages_manage_posts", "pages_read_engagement"] },
    { adapter: instagram, host: "www.instagram.com", scopes: ["instagram_business_basic", "instagram_business_content_publish"] },
    { adapter: threads, host: "threads.com", scopes: ["threads_basic", "threads_content_publish"] },
    { adapter: linkedin, host: "www.linkedin.com", scopes: ["w_organization_social", "r_organization_admin"] },
  ];

  for (const { adapter, host, scopes } of checks) {
    assert.equal(adapter.availability().available, true);
    const url = new URL(adapter.authorize!(data));
    assert.equal(url.hostname, host);
    assert.equal(url.searchParams.get("state"), data.state);
    assert.equal(url.searchParams.get("redirect_uri"), data.redirectUri);
    assert.equal(url.searchParams.has("client_secret"), false);
    for (const scope of scopes) assert.ok(url.searchParams.get("scope")?.split(/[, ]/).includes(scope));
  }
  const google = new URL(youtube.authorize!(data));
  assert.equal(google.searchParams.get("code_challenge_method"), "S256");
  assert.equal(google.searchParams.get("access_type"), "offline");
});

test("Instagram binds the documented professional account ID and preserves its size", async t => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.INSTAGRAM_CLIENT_ID = "test-id";
  process.env.INSTAGRAM_CLIENT_SECRET = "test-secret";

  mockFetch(t, (url, request) => {
    if (url.hostname === "api.instagram.com") {
      assert.equal(request.method, "POST");
      assert.equal((request.body as FormData).get("code"), "test-code");
      return Response.json({ access_token: "short-token" });
    }
    if (url.pathname === "/access_token") {
      assert.equal(url.searchParams.get("grant_type"), "ig_exchange_token");
      return Response.json({ access_token: "test-long-token", expires_in: 5000 });
    }
    if (url.pathname.endsWith("/me")) {
      assert.equal(url.searchParams.get("access_token"), "test-long-token");
      assert.equal(url.searchParams.get("fields"), "user_id,username");
      return Response.json({ data: [{ user_id: "17896450804038745", id: "223", username: "company" }] });
    }
    throw new Error("unexpected request");
  });

  const [credentials] = await instagram.exchange!({
    code: "test-code", redirectUri: "https://publisher.example.com/auth/callback", state: "nonce", verifier: "unused",
  });
  assert.equal(credentials.externalId, "17896450804038745");
  assert.equal(credentials.accountName, "company");
  assert.ok(credentials.expiresAt);
  await instagram.verify(credentials);
});

test("live Meta media creation rejects object storage localhost before making a request", async t => {
  const image = media("poster", "IMAGE");
  image.url = async () => "https://localhost:59000/poster";
  const { context, submissions } = makeContext([image]);
  let calls = 0;
  mockFetch(t, () => { calls += 1; throw new Error("unexpected network attempt"); });
  await assert.rejects(instagram.uploadMedia(context), error => error instanceof ProviderError && error.code === "meta_media_public");
  assert.equal(calls, 0);
  assert.equal(submissions(), 0);
});

test("LinkedIn signed image upload uses the documented LinkedIn authorization and escapes little text", async t => {
  const { context, submissions } = makeContext([media("poster", "IMAGE")]);
  context.payload.body = "公司（活动） [公司] @客服 #政府";
  let putRequests = 0;
  mockFetch(t, async (url, request) => {
    if (url.hostname === "www.linkedin.com") {
      assert.equal(request.method, "PUT");
      assert.equal(new Headers(request.headers).get("Authorization"), "Bearer fixture-token");
      assert.equal(await new Response(request.body).text(), "abcd");
      putRequests += 1;
      return new Response(null);
    }
    if (url.searchParams.get("action") === "initializeUpload") {
      return Response.json({ value: { uploadUrl: "https://www.linkedin.com/dms-uploads/poster", image: "urn:li:image:poster" } });
    }
    if (decodeURIComponent(url.pathname).endsWith("/urn:li:image:poster")) return Response.json({ status: "AVAILABLE" });
    if (url.pathname.endsWith("/rest/posts")) {
      assert.equal(submissions(), 1);
      const body = JSON.parse(String(request.body));
      assert.equal(body.commentary, String.raw`公司（活动） \[公司\] \@客服 #政府`);
      assert.equal(body.content.media.id, "urn:li:image:poster");
      return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:ugcPost:45" } });
    }
    throw new Error("unexpected request");
  });

  assert.deepEqual(await linkedin.uploadMedia(context), { kind: "ready" });
  assert.deepEqual(await linkedin.uploadMedia(context), { kind: "ready" });
  assert.equal(putRequests, 1);
  assert.equal((await linkedin.publish(context)).kind, "pending");
});

test("Threads renews access while preserving the independently tracked grant cutoff", async t => {
  const { context } = makeContext();
  const day = 24 * 3600 * 1000;
  const grantCutoff = new Date(Date.now() + 40 * day).toISOString();
  let refreshCalls = 0;
  mockFetch(t, url => {
    assert.equal(url.pathname, "/refresh_access_token");
    assert.equal(url.searchParams.get("access_token"), "fixture-token");
    assert.equal(url.searchParams.get("grant_type"), "th_refresh_token");
    refreshCalls += 1;
    return Response.json({ access_token: "renewed-token", expires_in: 60 * 24 * 3600 });
  });

  const renewed = await threads.refresh({
    ...context.credentials, expiresAt: new Date(Date.now() + 6 * day).toISOString(), refreshExpiresAt: grantCutoff,
  });
  assert.equal(renewed?.accessToken, "renewed-token");
  assert.equal(renewed?.expiresAt, grantCutoff);
  assert.equal(await threads.refresh({
    ...context.credentials, expiresAt: new Date(Date.now() + 4 * day).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 4 * day).toISOString(),
  }), null);
  assert.equal(refreshCalls, 1);
});

test("YouTube retains confirmed publishing when optional thumbnail is rejected", async t => {
  const { context } = makeContext([media("video", "VIDEO")], media("custom", "IMAGE"));
  context.externalId = "known-video";
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/videos")) return Response.json({ items: [{ id: "known-video", status: { uploadStatus: "processed" } }] });
    if (url.pathname.endsWith("/thumbnails/set")) return Response.json({}, { status: 403 });
    throw new Error("unexpected API");
  });
  const result = await youtube.queryStatus(context);
  assert.equal(result.kind, "success");
  if (result.kind === "success") {
    assert.match(result.url ?? "", /known-video/);
    assert.match(result.warning ?? "", /封面设置未确认/);
  }
});
