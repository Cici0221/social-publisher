import assert from "node:assert/strict";
import { test } from "node:test";
import { tiktok } from "../src/platforms/providers/tiktok";
import { x } from "../src/platforms/providers/x";
import { ProviderError, type AdapterContext, type Media } from "../src/platforms/types";

const api = "https://api.x.com/2";
const fourMiB = 4 * 1024 * 1024;
const creds = {
  externalId: "618", accountName: "@team_qa", accessToken: "fixture-access", refreshToken: "fixture-refresh",
  extras: { username: "team_qa" },
};

function fixture(media: Media[] = []) {
  let submitted = 0;
  const checkpoints: AdapterContext["state"][] = [];
  const context: AdapterContext = {
    taskId: "fixture-task", createdAt: new Date(), credentials: creds, media, state: {},
    payload: { title: "标题", body: "标题\n\n经过排版的正文\n\n#标签", tags: ["标签"], language: "ZH", assetIds: media.map(item => item.id), coverId: null, options: { consent: true } },
    checkpoint: async state => { context.state = state; checkpoints.push(structuredClone(state)); },
    beginSubmission: async () => { submitted++; },
  };
  return { context, checkpoints, submitCount: () => submitted };
}

function sample(id: string, mime: string, bytes: number, reads: Array<[number, number]> = []): Media {
  return {
    id, filename: id, mime, bytes, kind: mime.startsWith("video/") ? "VIDEO" : "IMAGE", width: null, height: null, duration: null,
    read: async (start = 0, end = bytes - 1) => { reads.push([start, end]); return Buffer.alloc(end - start + 1); },
    stream: async () => { throw new Error("unexpected stream"); },
    url: async () => { throw new Error("unexpected public URL"); },
  };
}

test("X OAuth enables all API scopes and validates the user context on the official hosts", async t => {
  const originalId = process.env.X_CLIENT_ID;
  const originalSecret = process.env.X_CLIENT_SECRET;
  process.env.X_CLIENT_ID = "fixture-app";
  process.env.X_CLIENT_SECRET = "fixture-secret";
  t.after(() => {
    if (originalId === undefined) delete process.env.X_CLIENT_ID;
    else process.env.X_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.X_CLIENT_SECRET;
    else process.env.X_CLIENT_SECRET = originalSecret;
  });
  const auth = { state: "fixture-state", verifier: "fixture-verifier", redirectUri: "https://internal.example.test/callback" };
  const url = new URL(x.authorize!(auth));
  assert.equal(url.origin + url.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(url.searchParams.get("state"), auth.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.notEqual(url.searchParams.get("code_challenge"), auth.verifier);
  assert.deepEqual(url.searchParams.get("scope")?.split(" "), ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"]);

  t.mock.method(globalThis, "fetch", async (target: string, options: RequestInit) => {
    const authorization = new Headers(options.headers).get("authorization");
    if (target === `${api}/users/me`) {
      assert.equal(authorization, "Bearer fixture-access");
      return Response.json({ data: { id: "618", username: "team_qa" } });
    }
    assert.equal(target, `${api}/oauth2/token`);
    assert.equal(authorization, `Basic ${Buffer.from("fixture-app:fixture-secret").toString("base64")}`);
    const params = options.body as URLSearchParams;
    if (params.get("grant_type") === "refresh_token") {
      assert.equal(params.get("refresh_token"), "fixture-refresh");
      return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 7_200 });
    }
    assert.equal(params.get("code"), "fixture-code");
    assert.equal(params.get("code_verifier"), auth.verifier);
    assert.equal(params.get("redirect_uri"), auth.redirectUri);
    return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 7_200 });
  });
  const [bound] = await x.exchange!({ ...auth, code: "fixture-code" });
  assert.equal(bound.externalId, "618");
  assert.equal(bound.accountName, "@team_qa");
  assert.ok(bound.expiresAt && Date.parse(bound.expiresAt) > Date.now());
  await x.verify(bound);
  const renewed = await x.refresh(bound);
  assert.equal(renewed?.refreshToken, "rotated-refresh");
  assert.equal(renewed?.accessToken, "rotated-access");
});

test("X keeps 4 MiB chunk ranges, reuses the finalize checkpoint, and only publishes once", async t => {
  const reads: Array<[number, number]> = [];
  const { context, checkpoints, submitCount } = fixture([sample("test-video", "video/mp4", fourMiB + 7, reads)]);
  const segments: string[] = [];
  let lostChunk = false;
  let statusCount = 0;
  let posts = 0;
  const mediaStage = () => (context.state.xMedia as { "test-video": { stage: string } } | undefined)?.["test-video"]?.stage;
  t.mock.method(globalThis, "fetch", async (target: string, options: RequestInit) => {
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer fixture-access");
    if (target === `${api}/media/upload/initialize`) {
      assert.equal(mediaStage(), "initializing");
      assert.deepEqual(JSON.parse(String(options.body)), {
        total_bytes: fourMiB + 7, media_type: "video/mp4", media_category: "tweet_video",
      });
      return Response.json({ data: { id: "812", expires_after_secs: 60 } });
    }
    if (target === `${api}/media/upload/812/append`) {
      const parts = options.body as FormData;
      const index = String(parts.get("segment_index"));
      segments.push(index);
      assert.equal((parts.get("media") as Blob).size, index === "0" ? fourMiB : 7);
      if (index === "1" && !lostChunk) { lostChunk = true; throw new Error("fixture dropped response"); }
      return new Response(null, { status: 204 });
    }
    if (target === `${api}/media/upload/812/finalize`) {
      assert.equal(mediaStage(), "finalizing");
      throw new Error("fixture lost finalize receipt");
    }
    if (target === `${api}/media/upload?command=STATUS&media_id=812`) {
      statusCount++;
      return Response.json({ data: { id: "812", processing_info: { state: statusCount === 1 ? "in_progress" : "succeeded", check_after_secs: 3 } } });
    }
    if (target === `${api}/tweets`) {
      posts++;
      assert.equal(submitCount(), 1);
      assert.deepEqual(JSON.parse(String(options.body)), { text: context.payload.body, media: { media_ids: ["812"] } });
      return Response.json({ data: { id: "711" } }, { status: 201 });
    }
    assert.equal(target, `${api}/tweets/711?tweet.fields=author_id`);
    return Response.json({ data: { id: "711", author_id: "618" } });
  });

  const networkError = (error: unknown) => error instanceof ProviderError && error.code === "network";
  await assert.rejects(x.uploadMedia(context), networkError);
  await assert.rejects(x.uploadMedia(context), networkError);
  assert.deepEqual(await x.uploadMedia(context), { kind: "pending", pollInMs: 3_000 });
  assert.deepEqual(await x.uploadMedia(context), { kind: "ready" });
  assert.equal(submitCount(), 0);
  assert.deepEqual(segments, ["0", "1", "1"]);
  assert.deepEqual(reads, [[0, fourMiB - 1], [fourMiB, fourMiB + 6], [fourMiB, fourMiB + 6]]);
  const result = { kind: "success", externalId: "711", url: "https://x.com/team_qa/status/711" };
  assert.deepEqual(await x.publish(context), result);
  assert.deepEqual(await x.publish(context), result);
  assert.deepEqual(await x.queryStatus(context), result);
  assert.equal(posts, 1);
  assert.equal(JSON.stringify(checkpoints).includes(creds.accessToken), false);
});

test("X reports unknown after losing a post response and does not infer success by media ID", async t => {
  const { context, submitCount } = fixture();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests++;
    assert.equal(url, `${api}/tweets`);
    throw new Error("lost receipt");
  });
  await assert.rejects(x.publish(context), (error: unknown) => error instanceof ProviderError && error.code === "network");
  assert.equal(submitCount(), 1);
  assert.deepEqual(await x.queryStatus(context), { kind: "unknown" });
  assert.equal(requests, 1);
});

test("X verifies status ownership, GIF exclusivity and explicit consent", async t => {
  const { context } = fixture([sample("gif", "image/gif", 1024), sample("photo", "image/png", 1024)]);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, `${api}/tweets/711?tweet.fields=author_id`);
    return Response.json({ data: { id: "711", author_id: "910" } });
  });
  await assert.rejects(x.validate!(context), (error: unknown) => error instanceof ProviderError && error.code === "x_gif_count");
  context.payload.options.consent = false;
  await assert.rejects(x.publish(context), (error: unknown) => error instanceof ProviderError && error.code === "x_consent");
  assert.deepEqual(await x.queryStatus({ ...context, externalId: "711" }), { kind: "unknown" });
});

test("TikTok exposes a clear live limitation and performs no network activity", async t => {
  const { context } = fixture();
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network request"); });
  assert.equal(tiktok.availability().available, false);
  assert.match(tiktok.availability().reason ?? "", /团队/);
  assert.equal(tiktok.authorize, undefined);
  await assert.rejects(tiktok.publish(context), (error: unknown) => error instanceof ProviderError && error.code === "tiktok_internal_use");
  assert.deepEqual(await tiktok.queryStatus(context), { kind: "unknown" });
});
