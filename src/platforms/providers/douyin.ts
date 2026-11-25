import { endpoint, envAvailable, expiresIn, form, jsonBody, platformJson, requireEnv } from "../http";
import { type AdapterContext, type Credentials, type Media, type PlatformAdapter, ProviderError } from "../types";

const api = "https://open.douyin.com";
const videoApi = api + "/api/douyin/v1/video/";
const key = () => requireEnv("DOUYIN_CLIENT_KEY");
const secret = () => requireEnv("DOUYIN_CLIENT_SECRET");
const writeScope = "video.create.bind";
const scopes = ["user_info", writeScope];
const MB = 1024 ** 2;
const simpleLimit = 50 * MB;
const partSize = 20 * MB;
const minPart = 5 * MB;

type DouyinReply<T> = {
  data?: T & { error_code?: number | string };
  extra?: { error_code?: number };
  err_no?: number;
};
type TokenData = {
  access_token?: string; refresh_token?: string; open_id?: string;
  expires_in?: number; refresh_expires_in?: number; scope?: string;
};

function unpack<T>(response: DouyinReply<T>): T {
  const codes = [response?.data?.error_code, response?.extra?.error_code, response?.err_no]
    .flatMap(value => typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? [Number(value)] : []);
  const code = codes.find(value => value !== 0) ?? codes[0];
  if (response?.data && code === 0) return response.data;
  if (!Number.isInteger(code)) {
    throw new ProviderError("douyin_response", "抖音未返回可识别的结果。", { retryable: true });
  }
  if ([10007, 10008, 10010, 28001003, 28001008].includes(Number(code))) {
    throw new ProviderError("douyin_" + code, "抖音授权已失效，请重新授权。", { definite: true, reauth: true });
  }
  if ([2100004, 28001005, 28001006].includes(Number(code))) {
    throw new ProviderError("douyin_" + code, "抖音接口暂不可用，提交结果需核对。", { retryable: true });
  }
  if ([2114007, 28003017].includes(Number(code))) {
    throw new ProviderError("douyin_" + code, "抖音当前的发布配额已用完。", { definite: true });
  }
  const definite = [10002, 10003, 10013, 10014, 210005, 2100005, 2114001, 2114006, 2114020, 2114021,
    2114022, 2114026, 2190005, 2190007, 28001007, 28001014, 28001016, 28001018, 28001019].includes(Number(code));
  throw new ProviderError("douyin_" + code, "抖音拒绝请求，请检查开放平台权限或内容限制。", { definite });
}

async function tokenRequest(path: string, fields: Record<string, string>) {
  const result = unpack(await platformJson<DouyinReply<TokenData>>(api + path, {
    method: "POST", body: form(fields),
  }));
  if (!result.access_token) throw new ProviderError("douyin_token", "抖音未返回授权凭据。", { definite: true });
  return {
    accessToken: result.access_token, refreshToken: result.refresh_token, openId: result.open_id,
    expiresAt: expiresIn(result.expires_in), refreshExpiresAt: expiresIn(result.refresh_expires_in),
    scope: result.scope,
  };
}

function accessTokenHeader(credentials: Credentials) {
  return { "access-token": credentials.accessToken };
}

async function profile(credentials: Credentials) {
  const data = unpack(await platformJson<DouyinReply<{ open_id?: string; nickname?: string }>>(api + "/oauth/userinfo/", {
    method: "POST", body: form({ open_id: credentials.externalId, access_token: credentials.accessToken }),
  }));
  if (data.open_id !== credentials.externalId) {
    throw new ProviderError("douyin_identity", "抖音授权账号与目标账号不一致。", { definite: true, reauth: true });
  }
  return data.nickname?.trim() || "抖音账号";
}

function profileScope(scope: string | undefined) {
  const values = scope?.split(/[, ]+/u) ?? [];
  if (scopes.some(value => !values.includes(value))) {
    throw new ProviderError("douyin_scope", "请授予抖音账号资料与代用户发布权限。", { definite: true, reauth: true });
  }
}

async function douyinMedia<T>(path: string, credentials: Credentials, params: Record<string, string | number> = {},
  init: Parameters<typeof platformJson>[1] = {}) {
  return unpack(await platformJson<DouyinReply<T>>(endpoint(videoApi + path, { open_id: credentials.externalId, ...params }), {
    ...init, method: "POST", headers: { ...accessTokenHeader(credentials), ...init.headers },
  }));
}

function matchId(value: unknown): string | undefined {
  return typeof value === "string" && value.length !== 0 ? value : undefined;
}

async function multipart(
  context: AdapterContext, video: Media, current: Record<string, unknown>,
): Promise<string | undefined> {
  const { credentials } = context;
  let uploadId = matchId(current.uploadId);
  if (!uploadId) {
    const data = await douyinMedia<{ upload_id?: string }>("init_video_part_upload/", credentials, {},
      { headers: { "Content-Type": "application/json" } });
    uploadId = matchId(data.upload_id);
    if (!uploadId) throw new ProviderError("douyin_upload_id", "抖音未返回分片上传凭据。", { retryable: true });
    await context.checkpoint({ ...current, uploadId });
  }
  const count = Math.ceil(video.bytes / partSize);
  const tail = video.bytes - (count - 1) * partSize;
  const move = Math.max(0, minPart - tail);
  const uploaded = typeof current.lastVideoPart === "number" ? current.lastVideoPart : 0;
  for (let part = uploaded + 1; part <= count; part++) {
    const start = (part - 1) * partSize - (part === count ? move : 0);
    const cutoff = Math.min(part * partSize, video.bytes) - (part === count - 1 ? move : 0);
    const payload = new FormData();
    const bytes = await video.read(start, cutoff - 1);
    payload.set("video", new Blob([Uint8Array.from(bytes)], { type: video.mime }), video.filename);
    await douyinMedia("upload_video_part/", credentials, { upload_id: uploadId, part_number: part },
      { body: payload, timeoutMs: 180_000 });
    await context.checkpoint({ ...current, uploadId, lastVideoPart: part });
  }
  const data = await douyinMedia<{ video?: { video_id?: string }; video_id?: string }>(
    "complete_video_part_upload/", credentials, { upload_id: uploadId }, { headers: { "Content-Type": "application/json" } });
  return matchId(data.video?.video_id) ?? matchId(data.video_id);
}

async function uploadFile(material: Media, credentials: Credentials) {
  const type = material.kind === "IMAGE" ? "image" : "video";
  const data = new FormData();
  const bytes = await material.read();
  data.set(type, new Blob([Uint8Array.from(bytes)], { type: material.mime }), material.filename);
  if (type === "image") return (await douyinMedia<{ image?: { image_id?: string } }>(
    "upload_image/", credentials, {}, { body: data, timeoutMs: 180_000 })).image?.image_id;
  return (await douyinMedia<{ video?: { video_id?: string } }>(
    "upload_video/", credentials, {}, { body: data, timeoutMs: 240_000 })).video?.video_id;
}

function validateConsent(context: AdapterContext) {
  if (context.payload.options.consent !== true) {
    throw new ProviderError("douyin_consent", "请确认将此次素材、文案和话题发布至该抖音账号。", { definite: true });
  }
}

export const douyinAdapter: PlatformAdapter = {
  key: "douyin",
  availability: () => envAvailable("DOUYIN_CLIENT_KEY", "DOUYIN_CLIENT_SECRET"),
  authorize: ({ redirectUri, state }) => {
    if (!redirectUri.startsWith("https://")) {
      throw new ProviderError("douyin_callback", "抖音网站应用需要已登记的 HTTPS 回调。", { definite: true });
    }
    return endpoint(api + "/platform/oauth/connect/", {
      client_key: key(), response_type: "code", scope: scopes.join(","), redirect_uri: redirectUri, state,
    });
  },
  exchange: async ({ code }) => {
    const token = await tokenRequest("/oauth/access_token/", {
      client_key: key(), client_secret: secret(), code, grant_type: "authorization_code",
    });
    profileScope(token.scope);
    if (!token.openId) throw new ProviderError("douyin_identity", "抖音未返回授权账号标识。", { definite: true });
    const credentials = { externalId: token.openId, accountName: "", accessToken: token.accessToken,
      refreshToken: token.refreshToken, expiresAt: token.expiresAt, refreshExpiresAt: token.refreshExpiresAt };
    return [{ ...credentials, accountName: await profile(credentials) }];
  },
  refresh: async credentials => {
    if (!credentials.refreshToken ||
      (credentials.refreshExpiresAt && Date.parse(credentials.refreshExpiresAt) <= Date.now())) return null;
    const token = await tokenRequest("/oauth/refresh_token/", {
      client_key: key(), refresh_token: credentials.refreshToken, grant_type: "refresh_token",
    });
    if (token.scope) profileScope(token.scope);
    if (token.openId && token.openId !== credentials.externalId) {
      throw new ProviderError("douyin_identity", "抖音续期返回了其他账号。", { definite: true, reauth: true });
    }
    return { ...credentials, accessToken: token.accessToken,
      expiresAt: token.expiresAt, refreshToken: token.refreshToken ?? credentials.refreshToken,
      refreshExpiresAt: token.refreshExpiresAt ?? credentials.refreshExpiresAt };
  },
  verify: async credentials => { await profile(credentials); },
  validate: async context => { validateConsent(context); },
  uploadMedia: async context => {
    validateConsent(context);
    const state = { ...context.state };
    if (!context.media.length) throw new ProviderError("douyin_media", "抖音需要视频或图片。", { definite: true });
    if (context.media[0].kind === "VIDEO") {
      if (!matchId(state.videoId)) {
        const video = context.media[0];
        const id = video.bytes > simpleLimit ? await multipart(context, video, state) : await uploadFile(video, context.credentials);
        if (!id) throw new ProviderError("douyin_upload", "抖音未返回视频素材 ID。", { retryable: true });
        state.videoId = id;
        await context.checkpoint(state);
      }
      if (context.cover && !matchId(state.coverId)) {
        const id = await uploadFile(context.cover, context.credentials);
        if (!id) throw new ProviderError("douyin_cover", "抖音未返回封面素材 ID。", { retryable: true });
        await context.checkpoint({ ...state, coverId: id });
      }
    } else {
      const ids = Array.isArray(state.imageIds) ? state.imageIds.filter((x): x is string => typeof x === "string") : [];
      for (const image of context.media.slice(ids.length)) {
        const id = await uploadFile(image, context.credentials);
        if (!id) throw new ProviderError("douyin_image", "抖音未返回图片素材 ID。", { retryable: true });
        ids.push(id);
        await context.checkpoint({ ...state, imageIds: [...ids] });
      }
    }
    return { kind: "ready" };
  },
  publish: async context => {
    validateConsent(context);
    const previous = context.externalId ?? matchId(context.state.douyinItem);
    if (previous) return { kind: "pending", externalId: previous, pollInMs: 120_000 };

    const videoId = matchId(context.state.videoId);
    const video = context.media[0]?.kind === "VIDEO";
    const imageIds = context.state.imageIds;
    if ((video && !videoId) || (!video && (!Array.isArray(imageIds) || imageIds.length !== context.media.length || !imageIds.length))) {
      throw new ProviderError("douyin_upload", "抖音素材尚未上传完成。", { definite: true });
    }
    const text = context.payload.body;
    const body = video ? { text, video_id: videoId, custom_cover_image_url: matchId(context.state.coverId) }
      : { text, image_list: imageIds };
    await context.beginSubmission();
    const item = await douyinMedia<{ item_id?: string; video_id?: string }>(
      video ? "create_video/" : "create_image_text/", context.credentials, {}, jsonBody(body));
    const id = matchId(item.item_id);
    if (!id) throw new ProviderError("douyin_submission", "抖音未返回作品编号，提交结果待核对。");
    await context.checkpoint({ ...context.state, douyinItem: id, douyinVideo: item.video_id });
    return { kind: "pending", externalId: id, pollInMs: 120_000 };
  },
  queryStatus: async () => {
    // The ordinary posting app's full moderation read contract is not publicly verified.
    return { kind: "unknown" };
  },
};
