import { platformRules } from "@/lib/platforms";
import { bearer, endpoint, envAvailable, expiresIn, form, jsonBody, pkce, platformFetch, platformJson, readJson, requireEnv } from "../http";
import { ProviderError, type AdapterContext, type Credentials, type Media, type PlatformAdapter, type SuccessOutcome } from "../types";

const api = "https://api.x.com/2/";
const mediaEndpoint = api + "media/upload";
const oauthEnvironment = ["X_CLIENT_ID", "X_CLIENT_SECRET"] as const;
const scopes = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"] as const;
const chunkBytes = 4 * 1024 * 1024;
const defaultMediaPollMs = 5_000;

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
type IdentityResponse = { data?: { id?: string; username?: string } };
type MediaReceipt = { data?: { id?: string; expires_after_secs?: number; processing_info?: { state?: string; check_after_secs?: number } } };
type PostResponse = { data?: { id?: string; author_id?: string } };

type UploadProgress = {
  stage: "initializing" | "appending" | "finalizing" | "processing" | "ready";
  id?: string;
  nextSegment?: number;
  expiresAt?: string;
  pollInMs?: number;
};

function validId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,19}$/.test(value);
}

function validUsername(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_]{1,15}$/.test(value);
}

async function token(parameters: Record<string, string>) {
  const id = requireEnv(oauthEnvironment[0]);
  const secret = requireEnv(oauthEnvironment[1]);
  const result = await platformJson<TokenResponse>(api + "oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
    body: form(parameters),
  });
  const expiresAt = expiresIn(result.expires_in);
  if (typeof result.access_token !== "string" || !result.access_token || !expiresAt) {
    throw new ProviderError("x_token", "X 未返回有效的授权令牌。", { retryable: true });
  }
  if (typeof result.scope === "string") {
    const granted = new Set(result.scope.split(/\s+/));
    if (scopes.some(scope => !granted.has(scope))) {
      throw new ProviderError("x_scope", "X 账号授权缺少所需权限，请重新绑定。", { definite: true, reauth: true });
    }
  }
  return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt };
}

async function identity(accessToken: string) {
  const { data } = await platformJson<IdentityResponse>(api + "users/me", { headers: bearer(accessToken) });
  if (!validId(data?.id) || !validUsername(data?.username)) {
    throw new ProviderError("x_identity", "X 无法确认所授权的账号。", { definite: true, reauth: true });
  }
  return { externalId: data.id, accountName: "@" + data.username, extras: { username: data.username } };
}

function success(credentials: Credentials, postId: string): SuccessOutcome {
  const username = credentials.extras?.username;
  return {
    kind: "success", externalId: postId,
    url: validUsername(username) ? `https://x.com/${username}/status/${postId}` : undefined,
  };
}

function requireConsent(context: AdapterContext) {
  if (context.payload.options.consent !== true) {
    throw new ProviderError("x_consent", "请确认 X 账号的发布授权和按量费用。", { definite: true });
  }
}

function checkMedia(media: Media[]) {
  const rules = platformRules.x;
  const photos = media.filter(item => item.kind === "IMAGE");
  const videos = media.filter(item => item.kind === "VIDEO");
  if (photos.length && videos.length || photos.length > (rules.image?.maxCount ?? 0) || videos.length > (rules.video?.maxCount ?? 0)) {
    throw new ProviderError("x_media_count", "X 不支持此图片和视频数量组合。", { definite: true });
  }
  if (photos.some(item => item.mime === "image/gif") && photos.length !== 1) {
    throw new ProviderError("x_gif_count", "X 的 GIF 必须独立作为唯一素材发布。", { definite: true });
  }
  for (const item of media) {
    const rule = item.kind === "VIDEO" ? rules.video : rules.image;
    const bytes = rule?.formatBytes?.[item.mime] ?? rule?.maxBytes;
    if (!rule?.formats.includes(item.mime) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || (bytes && item.bytes > bytes)) {
      throw new ProviderError("x_media_format", "X 素材格式或大小不符合要求。", { definite: true });
    }
  }
}

function progressMap(context: AdapterContext): Record<string, UploadProgress> {
  const value = context.state.xMedia;
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value as Record<string, UploadProgress> } : {};
}

function receiptProgress(result: MediaReceipt, previous?: UploadProgress): UploadProgress {
  const id = result.data?.id;
  if (!validId(id) || (previous?.id && previous.id !== id)) {
    throw new ProviderError("x_media_receipt", "X 未返回可用的媒体编号。", { retryable: true });
  }
  const expiresAt = expiresIn(result.data?.expires_after_secs) ?? previous?.expiresAt;
  const state = result.data?.processing_info?.state;
  if (state === "failed") throw new ProviderError("x_media_rejected", "X 未能处理所选媒体。", { definite: true });
  if (state === "pending" || state === "in_progress") {
    const seconds = result.data?.processing_info?.check_after_secs;
    const pollInMs = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMediaPollMs;
    return { id, expiresAt, stage: "processing", pollInMs };
  }
  if (state && state !== "succeeded") {
    throw new ProviderError("x_media_state", "X 返回了未识别的媒体处理状态。", { retryable: true });
  }
  return { id, expiresAt, stage: "ready" };
}

async function readBytes(item: Media, start: number, end: number) {
  const bytes = await item.read(start, end);
  if (bytes.length !== end - start + 1) {
    throw new ProviderError("x_media_read", "读取素材不完整，请重试。", { retryable: true });
  }
  return bytes;
}

async function uploadOne(context: AdapterContext, item: Media, entries: Record<string, UploadProgress>): Promise<UploadProgress> {
  let latest: UploadProgress | undefined = entries[item.id];
  const headers = bearer(context.credentials.accessToken);
  async function save(value: UploadProgress) {
    entries[item.id] = value;
    await context.checkpoint({ ...context.state, xMedia: { ...entries } });
    return value;
  }

  if (latest?.expiresAt && Date.parse(latest.expiresAt) <= Date.now()) latest = undefined;
  if (latest?.stage === "ready" && validId(latest.id)) return latest;

  if ((latest?.stage === "processing" || latest?.stage === "finalizing") && validId(latest.id)) {
    const response = await platformFetch(endpoint(mediaEndpoint, { command: "STATUS", media_id: latest.id }), {
      headers,
    }, [404, 410]);
    if (!response.ok) latest = undefined;
    else {
      const result = await readJson<MediaReceipt>(response);
      if (latest.stage === "processing" || result.data?.processing_info) {
        const progress = receiptProgress(result, latest);
        await save(progress);
        return progress;
      }
      // A checkpoint may precede a finalize that never reached X. Reuse the media ID.
    }
  }

  const gif = item.mime === "image/gif";
  if (item.kind === "IMAGE" && !gif) {
    await save({ stage: "initializing" });
    const bytes = await readBytes(item, 0, item.bytes - 1);
    const receipt = await platformJson<MediaReceipt>(mediaEndpoint, {
      method: "POST", ...jsonBody({ media: bytes.toString("base64"), media_category: "tweet_image" }, headers),
    });
    return save(receiptProgress(receipt));
  }

  if (!validId(latest?.id)) {
    await save({ stage: "initializing" });
    const result = await platformJson<MediaReceipt>(mediaEndpoint + "/initialize", {
      method: "POST", ...jsonBody({
        total_bytes: item.bytes, media_type: item.mime, media_category: gif ? "tweet_gif" : "tweet_video",
      }, headers),
    });
    const uploadId = result.data?.id;
    if (!validId(uploadId)) throw new ProviderError("x_media_init", "X 未返回媒体上传会话。", { retryable: true });
    latest = await save({ id: uploadId, stage: "appending", nextSegment: 0, expiresAt: expiresIn(result.data?.expires_after_secs) });
  }
  const uploadId = latest?.id;
  if (!latest || !validId(uploadId)) {
    throw new ProviderError("x_media_init", "X 未返回媒体上传会话。", { retryable: true });
  }

  if (latest.stage === "appending") {
    const count = Math.ceil(item.bytes / chunkBytes);
    const first = latest.nextSegment;
    if (typeof first !== "number" || !Number.isSafeInteger(first) || first < 0 || first > count) {
      throw new ProviderError("x_media_cursor", "X 媒体上传进度无效。", { definite: true });
    }
    for (let segment = first; segment < count; segment++) {
      const start = segment * chunkBytes;
      const bytes = await readBytes(item, start, Math.min(item.bytes, start + chunkBytes) - 1);
      const parts = new FormData();
      parts.set("segment_index", String(segment));
      parts.set("media", new Blob([new Uint8Array(bytes)], { type: item.mime }), "chunk");
      await platformFetch(`${mediaEndpoint}/${uploadId}/append`, { method: "POST", headers, body: parts });
      latest = await save({ ...latest, id: uploadId, nextSegment: segment + 1 });
    }
  }

  latest = await save({ ...latest, id: uploadId, stage: "finalizing" });
  const receipt = await platformJson<MediaReceipt>(`${mediaEndpoint}/${uploadId}/finalize`, { method: "POST", headers });
  return save(receiptProgress(receipt, latest));
}

export const x: PlatformAdapter = {
  key: "x",
  availability: () => envAvailable(...oauthEnvironment),
  authorize: context => endpoint("https://x.com/i/oauth2/authorize", {
    client_id: requireEnv(oauthEnvironment[0]), response_type: "code", redirect_uri: context.redirectUri,
    scope: scopes.join(" "), state: context.state, code_challenge: pkce(context.verifier), code_challenge_method: "S256",
  }),
  async exchange(context) {
    const credentials = await token({
      grant_type: "authorization_code", code: context.code, redirect_uri: context.redirectUri, code_verifier: context.verifier,
    });
    return [{ ...credentials, ...await identity(credentials.accessToken) }];
  },
  async refresh(credentials) {
    if (!credentials.refreshToken) return null;
    try {
      const renewed = await token({ grant_type: "refresh_token", refresh_token: credentials.refreshToken });
      return { ...credentials, ...renewed, refreshToken: renewed.refreshToken ?? credentials.refreshToken };
    } catch (error) {
      if (error instanceof ProviderError && (error.options.reauth || error.code === "platform_400")) return null;
      throw error;
    }
  },
  async verify(credentials) {
    if ((await identity(credentials.accessToken)).externalId !== credentials.externalId) {
      throw new ProviderError("x_identity", "X 当前授权与已绑定账号不一致。", { definite: true, reauth: true });
    }
  },
  async validate(context) {
    requireConsent(context);
    checkMedia(context.media);
    if (!context.payload.body.trim() && !context.media.length) {
      throw new ProviderError("x_empty_post", "请为 X 填写正文或添加素材。", { definite: true });
    }
  },
  async uploadMedia(context) {
    requireConsent(context);
    checkMedia(context.media);
    const entries = progressMap(context);
    let waitMs = 0;
    for (const item of context.media) {
      const progress = await uploadOne(context, item, entries);
      if (progress.stage === "processing") waitMs = Math.max(waitMs, progress.pollInMs ?? defaultMediaPollMs);
    }
    return waitMs ? { kind: "pending", pollInMs: waitMs } : { kind: "ready" };
  },
  async publish(context) {
    requireConsent(context);
    const existing = context.externalId ?? context.state.xPostId;
    if (validId(existing)) return success(context.credentials, existing);

    const uploads = progressMap(context);
    const mediaIds = context.media.map(item => uploads[item.id]).map(upload => {
      if (upload?.stage !== "ready" || !validId(upload.id)) {
        throw new ProviderError("x_media_pending", "X 素材尚未准备完成。", { definite: true });
      }
      return upload.id;
    });
    const text = context.payload.body.trim() ? context.payload.body : undefined;
    if (!text && !mediaIds.length) throw new ProviderError("x_empty_post", "请为 X 填写正文或添加素材。", { definite: true });
    await context.beginSubmission();
    const result = await platformJson<PostResponse>(api + "tweets", {
      method: "POST", ...jsonBody({ text, media: mediaIds.length ? { media_ids: mediaIds } : undefined }, bearer(context.credentials.accessToken)),
    });
    const id = result.data?.id;
    if (!validId(id)) throw new ProviderError("x_post_id", "X 未返回帖子编号，请核对发布结果。", { retryable: true });
    await context.checkpoint({ ...context.state, xPostId: id });
    return success(context.credentials, id);
  },
  async queryStatus(context) {
    const id = context.externalId ?? context.state.xPostId;
    if (!validId(id)) return { kind: "unknown" };
    const response = await platformFetch(endpoint(`${api}tweets/${id}`, { "tweet.fields": "author_id" }), {
      headers: bearer(context.credentials.accessToken),
    }, [404]);
    if (response.status === 404) return { kind: "unknown" };
    const { data } = await readJson<PostResponse>(response);
    return data?.id === id && data.author_id === context.credentials.externalId
      ? success(context.credentials, id)
      : { kind: "unknown" };
  },
};
