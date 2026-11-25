import { createHash } from "node:crypto";
import { languageTags } from "@/lib/platforms";
import { assertUpstreamUrl, bearer, endpoint, envAvailable, jsonBody, platformFetch, platformJson, readJson, requireEnv } from "../http";
import { ProviderError, type AdapterContext, type Credentials, type Media, type PlatformAdapter } from "../types";

const collection = "app.bsky.feed.post";
const defaultService = "https://bsky.social";
const videoService = "https://video.bsky.app";
const serviceHosts = ["bsky.social", ".bsky.network"];

type Session = { accessJwt: string; refreshJwt: string; did: string; handle: string; emailConfirmed?: boolean; didDoc?: {
  service?: { id?: string; type?: string; serviceEndpoint?: string }[];
} };
type VideoJob = { jobId: string; state: string; blob?: unknown; error?: string };
type Embed = { $type: string; [field: string]: unknown };

function pds(value: string) {
  return new URL(assertUpstreamUrl(value, serviceHosts)).origin;
}

function service(credentials: Credentials) {
  return pds(typeof credentials.extras?.service === "string" ? credentials.extras.service : defaultService);
}

function jwtExpiration(token: string) {
  try {
    const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp;
    return typeof exp === "number" ? new Date(exp * 1000).toISOString() : undefined;
  } catch { return undefined; }
}

function sessionCredentials(data: Session, originalService: string, confirmed?: boolean): Credentials {
  if (!/^did:(plc|web):/.test(data.did) || !data.accessJwt || !data.refreshJwt || !data.handle) {
    throw new ProviderError("invalid_bluesky_session", "Bluesky 未返回有效账号授权。", { definite: true });
  }
  const host = data.didDoc?.service?.find(item => item.id?.endsWith("#atproto_pds") || item.type === "AtprotoPersonalDataServer")?.serviceEndpoint;
  return {
    externalId: data.did, accountName: data.handle, accessToken: data.accessJwt, refreshToken: data.refreshJwt,
    expiresAt: jwtExpiration(data.accessJwt), refreshExpiresAt: jwtExpiration(data.refreshJwt),
    extras: { service: pds(host || originalService), emailConfirmed: data.emailConfirmed ?? confirmed ?? false },
  };
}

export function blueskyFacets(text: string) {
  type Feature = { $type: string; uri?: string; tag?: string };
  const matches: { start: number; end: number; feature: Feature }[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/giu)) {
    const uri = match[0].replace(/[.,!?:;）。，！？、)\]}]+$/u, "");
    try {
      const url = new URL(uri);
      if (!url.hostname || url.username || url.password) continue;
      matches.push({ start: match.index, end: match.index + uri.length, feature: { $type: "app.bsky.richtext.facet#link", uri: url.href } });
    } catch { continue; }
  }
  for (const match of text.matchAll(/(^|[\s([])#([\p{L}\p{N}\p{M}_-]{1,64})/gu)) {
    const start = match.index + match[1].length;
    const end = start + match[2].length + 1;
    if (!matches.some(item => item.start < end && item.end > start)) {
      matches.push({ start, end, feature: { $type: "app.bsky.richtext.facet#tag", tag: match[2] } });
    }
  }
  return matches.sort((a, b) => a.start - b.start).map(({ start, end, feature }) => ({
    index: { byteStart: Buffer.byteLength(text.slice(0, start)), byteEnd: Buffer.byteLength(text.slice(0, end)) },
    features: [feature],
  }));
}

const tidAlphabet = "234567abcdefghijklmnopqrstuvwxyz";
export function blueskyRecordKey(taskId: string, time: Date) {
  const entropy = createHash("sha256").update(taskId).digest().readUInt32BE(0);
  let value = ((BigInt(time.getTime()) * 1000n + BigInt(entropy % 1000)) << 10n) | BigInt((entropy >>> 10) % 1024);
  let key = "";
  for (let digit = 0; digit < 13; digit++) {
    key = tidAlphabet[Number(value & 31n)] + key;
    value >>= 5n;
  }
  return key;
}

function ratio(media: Media) {
  return media.width && media.height ? { aspectRatio: { width: media.width, height: media.height } } : {};
}

async function videoEmbed(context: AdapterContext, media: Media) {
  let job: VideoJob;
  if (typeof context.state.videoJob === "string") {
    const response = await platformJson<{ jobStatus: VideoJob }>(endpoint(videoService + "/xrpc/app.bsky.video.getJobStatus", { jobId: context.state.videoJob }));
    job = response.jobStatus;
  } else {
    const origin = service(context.credentials);
    const authorization = await platformJson<{ token: string }>(endpoint(origin + "/xrpc/com.atproto.server.getServiceAuth", {
      aud: "did:web:" + new URL(origin).hostname, lxm: "com.atproto.repo.uploadBlob", exp: Math.floor(Date.now() / 1000) + 1800,
    }), { headers: bearer(context.credentials.accessToken) });
    const response = await platformJson<VideoJob | { jobStatus: VideoJob }>(endpoint(videoService + "/xrpc/app.bsky.video.uploadVideo", {
      did: context.credentials.externalId, name: media.filename,
    }), { method: "POST", headers: { ...bearer(authorization.token), "Content-Type": media.mime, "Content-Length": String(media.bytes) },
      body: await media.stream(), duplex: "half", timeoutMs: 180_000 });
    job = "jobStatus" in response ? response.jobStatus : response;
    if (job?.jobId) await context.checkpoint({ ...context.state, videoJob: job.jobId });
  }
  if (job?.blob) return { $type: "app.bsky.embed.video", video: job.blob, alt: "", ...ratio(media) };
  if (!job?.jobId) throw new ProviderError("invalid_video_job", "Bluesky 未返回视频处理任务。", { retryable: true });
  if (job.error || /failed/i.test(job.state)) throw new ProviderError("video_rejected", "Bluesky 未能处理此视频。", { definite: true });
  return null;
}

async function inspectPost(context: AdapterContext) {
  const key = context.state.recordKey;
  if (typeof key !== "string") return { kind: "unknown" as const };
  const response = await platformFetch(endpoint(service(context.credentials) + "/xrpc/com.atproto.repo.getRecord", {
    repo: context.credentials.externalId, rkey: key, collection,
  }), { headers: bearer(context.credentials.accessToken) }, [400, 404]);
  const record = await readJson<{ uri?: string; value?: { text?: string; createdAt?: string }; error?: string }>(response);
  if (!response.ok) {
    if (response.status === 404 || record.error === "RecordNotFound") return { kind: "safe-to-resume" as const };
    return { kind: "unknown" as const };
  }
  if (record.value?.text !== context.payload.body || record.value?.createdAt !== context.state.recordAt || !record.uri) {
    return { kind: "unknown" as const };
  }
  return { kind: "success" as const, externalId: record.uri, url: `https://bsky.app/profile/${context.credentials.externalId}/post/${key}` };
}

export const bluesky: PlatformAdapter = {
  key: "bluesky",
  availability: () => envAvailable("BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"),
  async bindFromEnvironment() {
    const origin = pds(process.env.BLUESKY_PDS_URL || defaultService);
    const session = await platformJson<Session>(origin + "/xrpc/com.atproto.server.createSession", {
      method: "POST", ...jsonBody({ identifier: requireEnv("BLUESKY_IDENTIFIER"), password: requireEnv("BLUESKY_APP_PASSWORD") }),
    });
    return [sessionCredentials(session, origin)];
  },
  async refresh(credentials) {
    if (!credentials.refreshToken) return null;
    const origin = service(credentials);
    const session = await platformJson<Session>(origin + "/xrpc/com.atproto.server.refreshSession", {
      method: "POST", headers: bearer(credentials.refreshToken),
    });
    return sessionCredentials(session, origin, credentials.extras?.emailConfirmed === true);
  },
  async verify(credentials) {
    const checked = await platformJson<{ did: string }>(service(credentials) + "/xrpc/com.atproto.server.getSession", {
      headers: bearer(credentials.accessToken),
    });
    if (checked.did !== credentials.externalId) throw new ProviderError("account_mismatch", "Bluesky 账号与授权不一致。", { definite: true, reauth: true });
  },
  async uploadMedia(context) {
    if (context.state.embed || !context.media.length) return { kind: "ready" };
    const video = context.media.find(media => media.kind === "VIDEO");
    let embed: Embed | null;
    if (video) {
      embed = await videoEmbed(context, video);
      if (!embed) return { kind: "pending", pollInMs: 5000 };
    } else {
      const images = Array.isArray(context.state.images) ? [...context.state.images] : [];
      for (const media of context.media.slice(images.length)) {
        const result = await platformJson<{ blob: unknown }>(service(context.credentials) + "/xrpc/com.atproto.repo.uploadBlob", {
          method: "POST", headers: { ...bearer(context.credentials.accessToken), "Content-Type": media.mime, "Content-Length": String(media.bytes) },
          body: await media.stream(), duplex: "half",
        });
        if (!result.blob) throw new ProviderError("blob_missing", "Bluesky 未确认图片已上传。", { retryable: true });
        images.push({ image: result.blob, alt: "", ...ratio(media) });
        await context.checkpoint({ ...context.state, images });
      }
      embed = { $type: "app.bsky.embed.images", images };
    }
    await context.checkpoint({ ...context.state, embed });
    return { kind: "ready" };
  },
  async publish(context) {
    const recordAt = typeof context.state.recordAt === "string" ? context.state.recordAt : new Date().toISOString();
    const recordKey = typeof context.state.recordKey === "string" ? context.state.recordKey : blueskyRecordKey(context.taskId, new Date(recordAt));
    await context.checkpoint({ ...context.state, recordAt, recordKey });
    const facets = blueskyFacets(context.payload.body);
    const record = { $type: collection, text: context.payload.body, createdAt: recordAt, langs: [languageTags[context.payload.language]],
      ...(facets.length ? { facets } : {}), ...(context.state.embed ? { embed: context.state.embed } : {}) };
    await context.beginSubmission();
    const response = await platformFetch(service(context.credentials) + "/xrpc/com.atproto.repo.createRecord", {
      method: "POST", ...jsonBody({ repo: context.credentials.externalId, collection, rkey: recordKey, validate: true, record },
        bearer(context.credentials.accessToken)),
    }, [400, 409]);
    const result = await readJson<{ uri?: string; message?: string }>(response);
    if (!response.ok) {
      if (response.status === 409 || /already exists/i.test(result.message ?? "")) {
        const existing = await inspectPost(context);
        if (existing.kind === "success") return existing;
        throw new ProviderError("record_conflict", "Bluesky 记录键有冲突，实际发布结果需要核对。");
      }
      throw new ProviderError("post_rejected", "Bluesky 拒绝此内容，请检查文案和素材。", { definite: true });
    }
    if (!result.uri) throw new ProviderError("unknown_post", "Bluesky 未确认帖子地址。", { retryable: true });
    return { kind: "success", externalId: result.uri, url: `https://bsky.app/profile/${context.credentials.externalId}/post/${recordKey}` };
  },
  queryStatus: inspectPost,
};
