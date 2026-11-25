import {
  assertUpstreamUrl, bearer, endpoint, envAvailable, expiresIn, form, jsonBody, platformFetch,
  platformJson, requireEnv,
} from "../http";
import { ProviderError, type AdapterContext, type Credentials, type Media, type PlatformAdapter, type PublishOutcome, type UploadOutcome } from "../types";

const environment = ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"];
const api = "https://api.linkedin.com/rest/";
const oauth = "https://www.linkedin.com/oauth/v2/";
const scopes = ["w_organization_social", "r_organization_social", "r_organization_admin"];
const uploadHosts = ["www.linkedin.com", ".licdn.com"];
const poll = 15_000;

type Token = { access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number };
type Acls = {
  elements?: Array<{ organization?: string; organizationTarget?: string; role?: string; state?: string }>;
  paging?: { links?: Array<{ rel?: string }> };
};
type ImageSession = { id: string; url: string; expiresAt?: number; uploaded?: boolean };
type UploadPart = { firstByte: number; lastByte: number; uploadUrl: string };
type VideoSession = {
  id: string;
  parts: UploadPart[];
  uploadedPartIds: string[];
  uploadToken: string;
  expiresAt?: number;
  thumbnailUrl?: string;
  thumbnailUploaded?: true;
  finalized?: true;
};

function organizationUrn(id: string) {
  if (!/^\d+$/.test(id)) throw new ProviderError("linkedin_org_id", "LinkedIn 公司主页编号无效。", { definite: true });
  return "urn:li:organization:" + id;
}

function postUrn(value: unknown) {
  if (typeof value !== "string" || !/^urn:li:(?:share|ugcPost):\d+$/.test(value)) {
    throw new ProviderError("linkedin_post_id", "LinkedIn 未返回有效的帖子编号。", { retryable: true });
  }
  return value;
}

function mediaUrn(value: unknown, kind: "image" | "video") {
  if (typeof value !== "string" || !value.startsWith("urn:li:" + kind + ":") || !/^[A-Za-z0-9_-]+$/.test(value.split(":")[3] ?? "")) {
    throw new ProviderError("linkedin_media_id", "LinkedIn 未返回有效的素材编号。", { retryable: true });
  }
  return value;
}

function headers(accessToken: string) {
  const version = process.env.LINKEDIN_API_VERSION?.trim() || "202611";
  if (!/^20\d{2}(?:0[1-9]|1[0-2])$/.test(version)) {
    throw new ProviderError("linkedin_version", "LinkedIn API 版本配置无效。", { definite: true });
  }
  return { ...bearer(accessToken), "Linkedin-Version": version, "X-Restli-Protocol-Version": "2.0.0" };
}

function commentary(text: string) {
  // LinkedIn's little format reserves punctuation. Preserve recognized single-word hashtags.
  return text.replace(/#[\p{L}\p{M}\p{N}_]+|[|{}@\[\]()<>#\\*_~]/gu,
    value => value.startsWith("#") && value.length > 1 ? value : "\\" + value);
}

function tokenRequest(data: Record<string, string>) {
  return platformJson<Token>(oauth + "accessToken", {
    method: "POST",
    body: form({ ...data, client_id: requireEnv("LINKEDIN_CLIENT_ID"), client_secret: requireEnv("LINKEDIN_CLIENT_SECRET") }),
  });
}

async function approvedOrganizations(accessToken: string): Promise<string[]> {
  const ids = new Set<string>();
  for (let start = 0; ; start += 25) {
    const result = await platformJson<Acls>(endpoint(api + "organizationAcls", {
      q: "roleAssignee", state: "APPROVED", role: "ADMINISTRATOR", count: 25, start,
    }), { headers: headers(accessToken) });
    const previous = ids.size;
    for (const row of result.elements ?? []) {
      const id = (row.organizationTarget ?? row.organization ?? "").match(/^urn:li:organization:(\d+)$/)?.[1];
      if (id && row.role === "ADMINISTRATOR" && row.state === "APPROVED") ids.add(id);
    }
    if (previous === ids.size || !result.paging?.links?.some(link => link.rel === "next")) break;
  }
  return [...ids];
}

async function organizationName(id: string, token: string) {
  const info = await platformJson<{ localizedName?: string; vanityName?: string }>(api + "organizations/" + id, { headers: headers(token) });
  return info.localizedName ?? info.vanityName ?? "LinkedIn " + id;
}

function uploadUrl(value: unknown) {
  if (typeof value !== "string") throw new ProviderError("linkedin_upload_url", "LinkedIn 未返回有效的上传地址。", { retryable: true });
  return assertUpstreamUrl(value, uploadHosts);
}

async function uploadBinary(media: Media, rawUrl: string, start?: number, end?: number, extra: Record<string, string> = {}) {
  const url = uploadUrl(rawUrl);
  const length = start === undefined || end === undefined ? media.bytes : end - start + 1;
  return platformFetch(url, {
    method: "PUT", duplex: "half", timeoutMs: 120_000, body: await media.stream(start, end),
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(length), ...extra },
  });
}

async function uploadImages(context: AdapterContext): Promise<UploadOutcome> {
  const accessToken = context.credentials.accessToken;
  const stored = context.state.images && typeof context.state.images === "object"
    ? { ...context.state.images } as Record<string, ImageSession> : {};
  for (const media of context.media) {
    let image = stored[media.id];
    if (!image || (!image.uploaded && image.expiresAt && image.expiresAt <= Date.now())) {
      const result = await platformJson<{ value?: { image?: string; uploadUrl?: string; uploadUrlExpiresAt?: number } }>(
        endpoint(api + "images", { action: "initializeUpload" }), {
          method: "POST", ...jsonBody({ initializeUploadRequest: { owner: organizationUrn(context.credentials.externalId) } }, headers(accessToken)),
        });
      image = { id: mediaUrn(result.value?.image, "image"), url: uploadUrl(result.value?.uploadUrl), expiresAt: result.value?.uploadUrlExpiresAt };
      stored[media.id] = image;
      await context.checkpoint({ ...context.state, images: stored });
    }
    if (!image.uploaded) {
      const uploadHeaders = new URL(image.url).hostname === "www.linkedin.com" ? bearer(accessToken) : {};
      await uploadBinary(media, image.url, undefined, undefined, uploadHeaders);
      stored[media.id] = { ...image, uploaded: true };
      await context.checkpoint({ ...context.state, images: stored });
    }
    const result = await platformJson<{ status?: string }>(api + "images/" + encodeURIComponent(image.id), { headers: headers(accessToken) });
    if (result.status === "PROCESSING_FAILED") {
      throw new ProviderError("linkedin_image_processing", "LinkedIn 未能处理图片，请检查图片格式或大小。", { definite: true });
    }
    if (result.status !== "AVAILABLE") return { kind: "pending", pollInMs: poll };
  }
  return { kind: "ready" };
}

function verifyParts(value: UploadPart[], bytes: number): UploadPart[] {
  let offset = 0;
  const valid = value.length > 0 && value.every(part => {
    if (!Number.isSafeInteger(part.firstByte) || !Number.isSafeInteger(part.lastByte) ||
        part.firstByte !== offset || part.lastByte < part.firstByte || part.lastByte >= bytes) return false;
    offset = part.lastByte + 1;
    return true;
  });
  if (!valid || offset !== bytes) {
    throw new ProviderError("linkedin_ranges", "LinkedIn 返回的分片范围与视频大小不匹配。", { retryable: true });
  }
  return value.map(part => ({ ...part, uploadUrl: uploadUrl(part.uploadUrl) }));
}

async function initializeVideo(context: AdapterContext, media: Media) {
  const result = await platformJson<{
    value?: { video?: string; uploadToken?: string; uploadUrlsExpireAt?: number; thumbnailUploadUrl?: string; uploadInstructions?: UploadPart[] };
  }>(endpoint(api + "videos", { action: "initializeUpload" }), {
    method: "POST", ...jsonBody({ initializeUploadRequest: {
      owner: organizationUrn(context.credentials.externalId), fileSizeBytes: media.bytes,
      uploadCaptions: false, uploadThumbnail: Boolean(context.cover),
    } }, headers(context.credentials.accessToken)),
  });
  const upload = result.value;
  const session: VideoSession = {
    id: mediaUrn(upload?.video, "video"),
    parts: verifyParts(upload?.uploadInstructions ?? [], media.bytes),
    uploadedPartIds: [],
    uploadToken: upload?.uploadToken ?? "",
    expiresAt: upload?.uploadUrlsExpireAt,
    thumbnailUrl: context.cover ? uploadUrl(upload?.thumbnailUploadUrl) : undefined,
  };
  await context.checkpoint({ ...context.state, videoUpload: session });
  return session;
}

async function videoStatus(id: string, accessToken: string) {
  const result = await platformJson<{ status?: string }>(api + "videos/" + encodeURIComponent(mediaUrn(id, "video")), { headers: headers(accessToken) });
  if (result.status === "PROCESSING_FAILED") {
    throw new ProviderError("linkedin_video_processing", "LinkedIn 未能处理视频，请检查格式、时长或文件大小。", { definite: true });
  }
  return result.status;
}

async function uploadVideo(context: AdapterContext, media: Media): Promise<UploadOutcome> {
  const accessToken = context.credentials.accessToken;
  let session = context.state.videoUpload as VideoSession | undefined;
  if (!session || (!session.finalized && session.expiresAt && session.expiresAt < Date.now())) {
    session = await initializeVideo(context, media);
  }
  if (session.finalized) {
    return await videoStatus(session.id, accessToken) === "AVAILABLE" ? { kind: "ready" } : { kind: "pending", pollInMs: poll };
  }
  const uploadedPartIds = [...session.uploadedPartIds];
  for (const [index, part] of session.parts.entries()) {
    if (uploadedPartIds[index]) continue;
    const response = await uploadBinary(media, part.uploadUrl, part.firstByte, part.lastByte);
    const tag = response.headers.get("etag")?.replace(/^"|"$/g, "");
    if (!tag) throw new ProviderError("linkedin_etag", "LinkedIn 未返回上传分片编号。", { retryable: true });
    uploadedPartIds[index] = tag;
    session = { ...session, uploadedPartIds };
    await context.checkpoint({ ...context.state, videoUpload: session });
  }

  if (context.cover && !session.thumbnailUploaded) {
    await uploadBinary(context.cover, uploadUrl(session.thumbnailUrl), undefined, undefined, { "media-type-family": "STILLIMAGE" });
    session = { ...session, thumbnailUploaded: true };
    await context.checkpoint({ ...context.state, videoUpload: session });
  }

  const current = await videoStatus(session.id, accessToken);
  if (current !== "AVAILABLE" && current !== "PROCESSING") {
    await platformFetch(endpoint(api + "videos", { action: "finalizeUpload" }), {
      method: "POST", ...jsonBody({ finalizeUploadRequest: {
        video: session.id, uploadToken: session.uploadToken, uploadedPartIds,
      } }, headers(accessToken)),
    });
  }
  await context.checkpoint({ ...context.state, videoUpload: { ...session, finalized: true } });
  return current === "AVAILABLE" ? { kind: "ready" } : { kind: "pending", pollInMs: poll };
}

async function confirmedPost(context: AdapterContext, id: string): Promise<PublishOutcome> {
  const post = postUrn(id);
  const url = "https://www.linkedin.com/feed/update/" + post + "/";
  try {
    const result = await platformJson<{ lifecycleState?: string }>(
      endpoint(api + "posts/" + encodeURIComponent(post), { viewContext: "AUTHOR" }), {
        headers: headers(context.credentials.accessToken),
      });
    if (result.lifecycleState === "PUBLISH_FAILED") {
      throw new ProviderError("post_rejected", "LinkedIn 未能完成帖子发布。", { definite: true });
    }
    if (result.lifecycleState !== "PUBLISHED") return { kind: "pending", externalId: id, pollInMs: poll };
  } catch (error) {
    if (!(error instanceof ProviderError && error.options.definite && !error.options.retryable &&
        (error.code === "platform_403" || error.options.reauth))) throw error;
    // A successful POST already assigned this post URN. Loss of read access must never trigger duplicate publication.
  }
  return { kind: "success", externalId: id, url };
}

function credentialFields(response: Token, old?: Credentials) {
  if (!response.access_token) throw new ProviderError("linkedin_token", "LinkedIn 未返回访问令牌。", { definite: true });
  return {
    accessToken: response.access_token, expiresAt: expiresIn(response.expires_in),
    refreshToken: response.refresh_token ?? old?.refreshToken,
    refreshExpiresAt: expiresIn(response.refresh_token_expires_in) ?? old?.refreshExpiresAt,
  };
}

export const linkedin: PlatformAdapter = {
  key: "linkedin",
  availability: () => envAvailable(...environment),
  authorize: context => endpoint(oauth + "authorization", {
    response_type: "code", client_id: requireEnv("LINKEDIN_CLIENT_ID"), scope: scopes.join(" "),
    redirect_uri: context.redirectUri, state: context.state,
  }),
  async exchange(context) {
    const response = await tokenRequest({ code: context.code, grant_type: "authorization_code", redirect_uri: context.redirectUri });
    const fields = credentialFields(response);
    const orgs = await approvedOrganizations(fields.accessToken);
    if (!orgs.length) throw new ProviderError("linkedin_no_orgs", "该 LinkedIn 成员没有已批准的公司主页管理员权限。", { definite: true });
    return Promise.all(orgs.map(async externalId => ({
      ...fields, externalId, accountName: await organizationName(externalId, fields.accessToken),
    })));
  },
  async refresh(credentials) {
    if (!credentials.refreshToken || (credentials.refreshExpiresAt && Date.parse(credentials.refreshExpiresAt) <= Date.now())) return null;
    try {
      const response = await tokenRequest({ grant_type: "refresh_token", refresh_token: credentials.refreshToken });
      return { ...credentials, ...credentialFields(response, credentials) };
    } catch (error) {
      if (error instanceof ProviderError && (error.options.reauth || error.code === "platform_400")) return null;
      throw error;
    }
  },
  async verify(credentials) {
    if (!(await approvedOrganizations(credentials.accessToken)).includes(credentials.externalId)) {
      throw new ProviderError("linkedin_account", "当前 LinkedIn 成员无法管理所绑定的公司主页。", { definite: true, reauth: true });
    }
  },
  async validate(context) {
    const isVideo = context.media.some(media => media.kind === "VIDEO");
    if (context.cover && !isVideo) throw new ProviderError("linkedin_cover", "LinkedIn 视频封面需要同时选择视频。", { definite: true });
  },
  async uploadMedia(context) {
    if (context.externalId || typeof context.state.postId === "string" || !context.media.length) return { kind: "ready" };
    const video = context.media.find(media => media.kind === "VIDEO");
    return video ? uploadVideo(context, video) : uploadImages(context);
  },
  async publish(context) {
    const known = context.externalId ?? (typeof context.state.postId === "string" ? context.state.postId : undefined);
    if (known) return confirmedPost(context, known);
    const video = context.state.videoUpload as VideoSession | undefined;
    const images = context.state.images as Record<string, ImageSession> | undefined;
    let content;
    if (context.media.some(media => media.kind === "VIDEO")) {
      content = { media: { id: mediaUrn(video?.id, "video"), title: context.payload.title || undefined } };
    } else if (context.media.length) {
      const ids = context.media.map(media => mediaUrn(images?.[media.id]?.id, "image"));
      content = ids.length === 1 ? { media: { id: ids[0] } } : { multiImage: { images: ids.map(id => ({ id })) } };
    }
    const request = {
      method: "POST",
      ...jsonBody({
        author: organizationUrn(context.credentials.externalId),
        commentary: commentary(context.payload.body),
        visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false, content,
      }, headers(context.credentials.accessToken)),
    };
    await context.beginSubmission();
    const response = await platformFetch(api + "posts", request);
    const id = postUrn(response.headers.get("x-restli-id"));
    await context.checkpoint({ ...context.state, postId: id });
    return { kind: "pending", externalId: id, pollInMs: 1000 };
  },
  async queryStatus(context) {
    const id = context.externalId ?? (typeof context.state.postId === "string" ? context.state.postId : undefined);
    return id ? confirmedPost(context, id) : { kind: "unknown" };
  },
};
