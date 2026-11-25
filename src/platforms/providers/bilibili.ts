import { createHash, createHmac, randomUUID } from "node:crypto";
import { endpoint, envAvailable, platformJson, requireEnv } from "../http";
import { type AdapterContext, type Credentials, type Media, type PlatformAdapter, ProviderError } from "../types";

const oauth = "https://api.bilibili.com/x/account-oauth2/v1";
const gateway = "https://member.bilibili.com/arcopen/fn";
const uploadGateway = "https://openupos.bilivideo.com/video/v2";
const clientId = () => requireEnv("BILIBILI_CLIENT_ID");
const secret = () => requireEnv("BILIBILI_CLIENT_SECRET");
const neededScopes = ["USER_INFO", "ARC_BASE"] as const;
const singleUploadLimit = 100 * 1000 * 1000;
const uploadPartBytes = 10 * 1000 * 1000;

type BiliReply<T> = { code?: number; data?: T };
type TokenData = { access_token?: string; refresh_token?: string; expires_in?: number; scopes?: string[] };
type UserData = { openid?: string; name?: string; scopes?: string[] };

function unpack<T>(reply: BiliReply<T>): T | undefined {
  if (reply?.code === 0) return reply.data;
  const code = reply?.code;
  if (typeof code !== "number") throw new ProviderError("bilibili_response", "哔哩哔哩返回的结果无法识别。", { retryable: true });
  if ([122002, 122007, 127001, 127011].includes(code)) {
    throw new ProviderError("bilibili_" + code, "哔哩哔哩账号授权失效或缺少权限，请重新授权。",
      { definite: true, reauth: true });
  }
  if ([127009, 127306].includes(code)) {
    throw new ProviderError("bilibili_" + code, "哔哩哔哩接口达到调用频率限制。", { definite: true, retryable: true });
  }
  if ([4010, 4011, 122009, 122010, 123039].includes(code)) {
    throw new ProviderError("bilibili_" + code, "哔哩哔哩接口暂不可用，提交结果需核对。", { retryable: true });
  }
  const definite = [4000, 4001, 4002, 4003, 4005, 4006, 4007, 4008, 4009, 122000, 122001,
    127000, 127002, 127003, 127004, 127005, 127006, 127007, 127008, 127010,
    127022, 127304, 127305, 123030, 123036, 123037, 123038, 123045, 123052].includes(code);
  throw new ProviderError("bilibili_" + code, "哔哩哔哩拒绝请求，请检查投稿权限、分区或内容要求。", { definite });
}

function scopeCheck(scopes: string[] | undefined) {
  if (!scopes || neededScopes.some(scope => !scopes.includes(scope))) {
    throw new ProviderError("bilibili_scope", "请为哔哩哔哩账号授予基础资料与视频投稿权限。", { definite: true, reauth: true });
  }
}

function tokenDeadline(value?: number) {
  if (!Number.isSafeInteger(value) || !value || value < 946684800 || value > 4102444800) {
    throw new ProviderError("bilibili_expiry", "哔哩哔哩没有返回有效的授权截止时间。", { definite: true });
  }
  return new Date(value * 1000).toISOString();
}

function sign(accessToken: string, body: string) {
  const headers: Record<string, string> = {
    "x-bili-accesskeyid": clientId(),
    "x-bili-content-md5": createHash("md5").update(body, "utf8").digest("hex"),
    "x-bili-signature-method": "HMAC-SHA256",
    "x-bili-signature-nonce": randomUUID(),
    "x-bili-signature-version": "2.0",
    "x-bili-timestamp": String(Math.floor(Date.now() / 1000)),
  };
  const signed = Object.keys(headers).sort().map(key => key + ":" + headers[key]).join("\n");
  return { ...headers, Accept: "application/json", "access-token": accessToken,
    Authorization: createHmac("sha256", secret()).update(signed, "utf8").digest("hex") };
}

async function signedCall<T>(path: string, credentials: Credentials, options: {
  method?: "GET" | "POST"; params?: Record<string, string>; data?: object; file?: FormData;
} = {}) {
  const body = options.data === undefined ? "" : JSON.stringify(options.data);
  const headers = sign(credentials.accessToken, body);
  return unpack(await platformJson<BiliReply<T>>(endpoint(gateway + path, options.params), {
    method: options.method ?? "GET",
    headers: options.file ? headers : { ...headers, "Content-Type": "application/json" },
    body: options.file ?? (options.data === undefined ? undefined : body),
  }));
}

async function requestToken(fields: { code: string } | { refresh_token: string }) {
  const refreshing = "refresh_token" in fields;
  const token = unpack(await platformJson<BiliReply<TokenData>>(endpoint(
    oauth + (refreshing ? "/refresh_token" : "/token"),
    { client_id: clientId(), client_secret: secret(), grant_type: refreshing ? "refresh_token" : "authorization_code", ...fields },
  ), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
  if (!token?.access_token || !token.refresh_token) {
    throw new ProviderError("bilibili_token", "哔哩哔哩没有返回完整授权凭据。", { definite: true });
  }
  return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: tokenDeadline(token.expires_in),
    scopes: token.scopes };
}

async function readUser(credentials: Credentials) {
  const user = await signedCall<UserData>("/user/account/info", credentials);
  if (!user?.openid) throw new ProviderError("bilibili_identity", "哔哩哔哩无法确认授权账号。", { definite: true, reauth: true });
  return { externalId: user.openid, accountName: user.name?.trim() || "哔哩哔哩账号" };
}

function getVideo(context: AdapterContext): Media {
  const video = context.media[0];
  if (context.media.length !== 1 || video?.kind !== "VIDEO") {
    throw new ProviderError("bilibili_video", "哔哩哔哩投稿需要一个视频。", { definite: true });
  }
  return video;
}

function submission(context: AdapterContext) {
  const { title, body, tags, options } = context.payload;
  const tid = Number(options.categoryId);
  const copyright = String(options.copyright);
  const source = typeof options.source === "string" ? options.source.trim() : "";
  if (!title.trim() || !Number.isSafeInteger(tid) || tid < 1 || !tags.length || tags.some(tag => /[,，]/u.test(tag)) ||
      !["1", "2"].includes(copyright) || (copyright === "2" && !source)) {
    throw new ProviderError("bilibili_details", "请填写视频标题、二级分区、有效标签和版权信息。", { definite: true });
  }
  return { title, tid, tag: tags.join(","), desc: body, copyright: Number(copyright),
    ...(copyright === "2" ? { source } : {}) };
}

function stateString(context: AdapterContext, key: string) {
  const value = context.state[key];
  return typeof value === "string" && value.length ? value : undefined;
}

async function uploadSingleVideo(context: AdapterContext, video: Media, token: string) {
  unpack(await platformJson<BiliReply<unknown>>(endpoint(uploadGateway + "/upload", { upload_token: token }), {
    method: "POST", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(video.bytes) },
    body: await video.stream(), duplex: "half", timeoutMs: 4 * 60_000,
  }));
}

async function uploadVideoParts(context: AdapterContext, video: Media, token: string) {
  const { credentials } = context;
  const number = typeof context.state.videoPart === "number" ? context.state.videoPart : 0;
  const count = Math.ceil(video.bytes / uploadPartBytes);
  for (let part = number + 1; part <= count; part++) {
    const start = (part - 1) * uploadPartBytes;
    const end = Math.min(video.bytes, start + uploadPartBytes) - 1;
    const url = endpoint(uploadGateway + "/part/upload", { upload_token: token, part_number: part });
    unpack(await platformJson<BiliReply<unknown>>(url, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(end - start + 1) },
      body: await video.stream(start, end), duplex: "half", timeoutMs: 4 * 60_000,
    }));
    await context.checkpoint({ ...context.state, uploadToken: token, videoPart: part });
  }
  await signedCall("/archive/video/complete", credentials, { method: "POST", params: { upload_token: token } });
}

export const bilibiliAdapter: PlatformAdapter = {
  key: "bilibili",
  availability: () => envAvailable("BILIBILI_CLIENT_ID", "BILIBILI_CLIENT_SECRET"),
  authorize: ({ redirectUri, state }) => endpoint("https://account.bilibili.com/pc/account-pc/auth/oauth",
    { client_id: clientId(), gourl: redirectUri, state }),
  exchange: async ({ code }) => {
    const { scopes, ...token } = await requestToken({ code });
    scopeCheck(scopes);
    const account = await readUser({ ...token, externalId: "", accountName: "" });
    return [{ ...token, ...account }];
  },
  refresh: async credentials => {
    if (!credentials.refreshToken || (credentials.expiresAt && Date.parse(credentials.expiresAt) <= Date.now())) return null;
    const { scopes, ...token } = await requestToken({ refresh_token: credentials.refreshToken });
    if (scopes) scopeCheck(scopes);
    return { ...credentials, ...token };
  },
  verify: async credentials => {
    const user = await readUser(credentials);
    if (user.externalId !== credentials.externalId) {
      throw new ProviderError("bilibili_identity", "哔哩哔哩凭据与目标账号不一致。", { definite: true, reauth: true });
    }
    scopeCheck((await signedCall<UserData>("/user/account/scopes", credentials))?.scopes);
  },
  validate: async context => {
    getVideo(context);
    submission(context);
  },
  uploadMedia: async context => {
    const { credentials, cover } = context;
    const video = getVideo(context);
    const chunked = video.bytes > singleUploadLimit;
    let state = { ...context.state };
    let token = stateString(context, "uploadToken");
    if (!token) {
      token = (await signedCall<{ upload_token?: string }>("/archive/video/init", credentials,
        { method: "POST", data: { name: video.filename, utype: chunked ? "0" : "1" } }))?.upload_token;
      if (!token) throw new ProviderError("bilibili_upload", "哔哩哔哩未返回视频上传凭据。", { retryable: true });
      state = { ...state, uploadToken: token };
      await context.checkpoint(state);
    }
    if (state.videoUploaded !== true) {
      if (chunked) await uploadVideoParts(context, video, token);
      else await uploadSingleVideo(context, video, token);
      state = { ...state, uploadToken: token, videoUploaded: true };
      await context.checkpoint(state);
    }
    if (cover && !state.coverUrl) {
      const form = new FormData();
      form.set("file", new Blob([Uint8Array.from(await cover.read())], { type: cover.mime }), cover.filename);
      const coverUrl = (await signedCall<{ url?: string }>("/archive/cover/upload", credentials,
        { method: "POST", file: form }))?.url;
      if (!coverUrl) throw new ProviderError("bilibili_cover", "哔哩哔哩未返回封面地址。", { retryable: true });
      await context.checkpoint({ ...state, coverUrl });
    }
    return { kind: "ready" };
  },
  publish: async context => {
    const known = context.externalId ?? stateString(context, "bilibiliId");
    if (known) return { kind: "pending", externalId: known, pollInMs: 60_000 };
    const token = stateString(context, "uploadToken");
    if (!token || context.state.videoUploaded !== true) {
      throw new ProviderError("bilibili_upload", "哔哩哔哩视频素材尚未上传完成。", { definite: true });
    }
    const data = { ...submission(context), cover: stateString(context, "coverUrl") };
    await context.beginSubmission();
    const resourceId = (await signedCall<{ resource_id?: string }>("/archive/add-by-utoken", context.credentials,
      { method: "POST", params: { upload_token: token }, data }))?.resource_id;
    if (!resourceId) throw new ProviderError("bilibili_submission", "哔哩哔哩未返回稿件编号，提交结果待核对。");
    await context.checkpoint({ ...context.state, bilibiliId: resourceId });
    return { kind: "pending", externalId: resourceId, pollInMs: 60_000 };
  },
  queryStatus: async context => {
    const resourceId = context.externalId ?? stateString(context, "bilibiliId");
    if (!resourceId) return { kind: "unknown" };
    const row = await signedCall<{ addit_info?: { state?: number; reject_reason?: string } }>("/archive/view",
      context.credentials, { params: { resource_id: resourceId } });
    if (row?.addit_info?.state === 0) {
      const url = /^(BV[A-Za-z0-9]{10,16}|av[1-9]\d{0,28})$/.test(resourceId)
        ? "https://www.bilibili.com/video/" + resourceId : undefined;
      return { kind: "success", externalId: resourceId, url };
    }
    if (row?.addit_info?.reject_reason?.trim()) {
      throw new ProviderError("moderation_rejected", "哔哩哔哩退回稿件，请在创作中心查看审核意见。", { definite: true });
    }
    return { kind: "pending", externalId: resourceId, pollInMs: 60_000 };
  },
};
