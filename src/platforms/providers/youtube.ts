import { languageTags } from "@/lib/platforms";
import {
  assertUpstreamUrl, bearer, endpoint, envAvailable, expiresIn, form, jsonBody, pkce,
  platformFetch, platformJson, readJson, requireEnv,
} from "../http";
import { ProviderError, type AdapterContext, type Media, type PlatformAdapter, type PublishOutcome, type StatusOutcome } from "../types";

const tokenUrl = "https://oauth2.googleapis.com/token";
const api = "https://www.googleapis.com/youtube/v3/";
const upload = "https://www.googleapis.com/upload/youtube/v3/";
const audienceScopes = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];
const setupNames = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"];
const chunkBytes = 32 * 1024 * 1024;
const pendingPoll = 15_000;

type Token = { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number };
type ChannelList = { items?: Array<{ id?: string; snippet?: { title?: string } }> };
type VideoResult = {
  id?: string;
  status?: { uploadStatus?: string; failureReason?: string; rejectionReason?: string };
  processingDetails?: { processingStatus?: string };
};
type Resumable = { complete: true; id: string } | { complete: false; offset: number };

function responseId(id: string | undefined): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ProviderError("youtube_missing_video", "YouTube 未返回有效的视频编号。", { retryable: true });
  }
  return id;
}

async function token(parameters: Record<string, string>): Promise<Token & { access_token: string }> {
  const result = await platformJson<Token>(tokenUrl, {
    method: "POST",
    body: form({
      ...parameters,
      client_id: requireEnv("YOUTUBE_CLIENT_ID"),
      client_secret: requireEnv("YOUTUBE_CLIENT_SECRET"),
    }),
  });
  if (!result.access_token) throw new ProviderError("youtube_token", "YouTube 未返回授权令牌。", { definite: true });
  return { ...result, access_token: result.access_token };
}

function listChannels(accessToken: string) {
  return platformJson<ChannelList>(endpoint(api + "channels", { mine: true, part: "id,snippet" }), { headers: bearer(accessToken) });
}

function videoOf(context: AdapterContext): Media {
  const [video] = context.media;
  if (context.media.length !== 1 || !video || video.kind !== "VIDEO" || video.bytes < 1) {
    throw new ProviderError("youtube_video_required", "YouTube 发布需要一个有效的视频。", { definite: true });
  }
  return video;
}

function privacyOf(context: AdapterContext): string {
  const privacy = context.payload.options.privacy;
  if (privacy !== "public" && privacy !== "unlisted" && privacy !== "private") {
    throw new ProviderError("youtube_privacy_required", "请选择 YouTube 的公开范围。", { definite: true });
  }
  return privacy;
}

function sessionOf(context: AdapterContext) {
  return typeof context.state.sessionUrl === "string"
    ? assertUpstreamUrl(context.state.sessionUrl, ["www.googleapis.com"])
    : null;
}

async function uploadResult(response: Response, size: number): Promise<Resumable> {
  if (response.status !== 308) {
    const result = await readJson<VideoResult>(response);
    return { complete: true, id: responseId(result.id) };
  }
  const range = response.headers.get("range");
  const match = range?.match(/^bytes=0-(\d+)$/);
  const offset = match ? Number(match[1]) + 1 : 0;
  if ((range && !match) || !Number.isSafeInteger(offset) || offset < 0 || offset >= size) {
    throw new ProviderError("youtube_upload_range", "YouTube 返回了无效的续传位置。", { retryable: true });
  }
  return { complete: false, offset };
}

async function checkpointVideo(context: AdapterContext, id: string) {
  const state = { ...context.state };
  delete state.sessionUrl;
  delete state.uploadedBytes;
  await context.checkpoint({ ...state, videoId: id });
}

async function statusForVideo(context: AdapterContext, videoId: string): Promise<PublishOutcome> {
  const id = responseId(videoId);
  const result = await platformJson<{ items?: VideoResult[] }>(endpoint(api + "videos", {
    id, part: "status,processingDetails",
  }), { headers: bearer(context.credentials.accessToken) });
  const video = result.items?.find(item => item.id === id);
  const status = video?.status?.uploadStatus;
  const processing = video?.processingDetails?.processingStatus;
  if (status === "failed" || status === "rejected" || status === "deleted" || processing === "failed" ||
      processing === "terminated") {
    const cause = video?.status?.rejectionReason ?? video?.status?.failureReason;
    const message = cause === "copyright" ? "YouTube 版权检查未通过。" :
      cause === "duplicate" ? "YouTube 将该视频判定为重复内容。" :
      "YouTube 拒绝了视频或未能完成视频处理。";
    throw new ProviderError("post_rejected", message, { definite: true });
  }
  if (status !== "processed" && processing !== "succeeded") {
    return { kind: "pending", externalId: id, pollInMs: pendingPoll };
  }

  if (context.cover && context.state.thumbnailSet !== true) {
    if (context.cover.kind !== "IMAGE" || context.cover.bytes <= 0 || context.cover.bytes > 50_000_000) {
      throw new ProviderError("youtube_cover", "YouTube 视频已上传，但封面格式或体积不符合要求。", { definite: true });
    }
    try {
      const body = await context.cover.stream();
      await platformFetch(endpoint(upload + "thumbnails/set", { videoId: id, uploadType: "media" }), {
        method: "POST", duplex: "half", body,
        headers: { ...bearer(context.credentials.accessToken), "Content-Type": context.cover.mime, "Content-Length": String(context.cover.bytes) },
      });
    } catch (error) {
      if (error instanceof ProviderError && error.options.retryable) throw error;
      throw new ProviderError("youtube_cover", "YouTube 视频已上传，但此频道未能设置所选封面。", { definite: true });
    }
    await context.checkpoint({ ...context.state, videoId: id, thumbnailSet: true });
  }

  return { kind: "success", externalId: id, url: endpoint("https://www.youtube.com/watch", { v: id }) };
}

export const youtube: PlatformAdapter = {
  key: "youtube",
  availability: () => envAvailable(...setupNames),
  authorize: context => endpoint("https://accounts.google.com/o/oauth2/v2/auth", {
    client_id: requireEnv("YOUTUBE_CLIENT_ID"),
    redirect_uri: context.redirectUri,
    state: context.state,
    response_type: "code",
    scope: audienceScopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: pkce(context.verifier),
    code_challenge_method: "S256",
  }),
  async exchange(context) {
    const result = await token({
      code: context.code, redirect_uri: context.redirectUri, grant_type: "authorization_code",
      code_verifier: context.verifier,
    });
    const accessToken = result.access_token;
    const channels = await listChannels(accessToken);
    const credentials = (channels.items ?? []).flatMap(channel => channel.id && channel.snippet?.title ? [{
      externalId: channel.id,
      accountName: channel.snippet.title,
      accessToken,
      refreshToken: result.refresh_token,
      expiresAt: expiresIn(result.expires_in),
      refreshExpiresAt: expiresIn(result.refresh_token_expires_in),
    }] : []);
    if (!credentials.length) throw new ProviderError("youtube_channel", "该 Google 授权未返回可发布的 YouTube 频道。", { definite: true });
    return credentials;
  },
  async refresh(credentials) {
    if (!credentials.refreshToken) return null;
    let result: Awaited<ReturnType<typeof token>>;
    try {
      result = await token({ grant_type: "refresh_token", refresh_token: credentials.refreshToken });
    } catch (error) {
      if (error instanceof ProviderError && (error.code === "platform_400" || error.options.reauth)) return null;
      throw error;
    }
    return {
      ...credentials,
      accessToken: result.access_token,
      refreshToken: result.refresh_token ?? credentials.refreshToken,
      expiresAt: expiresIn(result.expires_in),
      refreshExpiresAt: expiresIn(result.refresh_token_expires_in) ?? credentials.refreshExpiresAt,
    };
  },
  async verify(credentials) {
    const channels = await listChannels(credentials.accessToken);
    if (!channels.items?.some(item => item.id === credentials.externalId)) {
      throw new ProviderError("youtube_channel", "当前授权无法访问该 YouTube 频道。", { definite: true, reauth: true });
    }
  },
  async validate(context) {
    videoOf(context);
    privacyOf(context);
    if (!context.payload.title.trim()) throw new ProviderError("youtube_title", "YouTube 视频需要标题。", { definite: true });
  },
  async uploadMedia(context) {
    if (context.externalId || typeof context.state.videoId === "string" || sessionOf(context)) return { kind: "ready" };
    const video = videoOf(context);
    const categoryId = context.payload.options.categoryId;
    const response = await platformFetch(endpoint(upload + "videos", { uploadType: "resumable", part: "snippet,status" }), {
      ...jsonBody({
        snippet: {
          title: context.payload.title,
          description: context.payload.body,
          categoryId: String(categoryId ?? 22),
          tags: context.payload.tags,
          defaultLanguage: languageTags[context.payload.language],
        },
        status: {
          privacyStatus: privacyOf(context),
          selfDeclaredMadeForKids: context.payload.options.madeForKids === true,
        },
      }, { ...bearer(context.credentials.accessToken), "X-Upload-Content-Type": video.mime, "X-Upload-Content-Length": String(video.bytes) }),
      method: "POST",
    });
    const location = response.headers.get("location");
    if (!location) throw new ProviderError("youtube_location", "YouTube 未返回上传会话。", { retryable: true });
    await context.checkpoint({ ...context.state, sessionUrl: assertUpstreamUrl(location, ["www.googleapis.com"]), uploadedBytes: 0 });
    return { kind: "ready" };
  },
  async publish(context) {
    const known = context.externalId ?? (typeof context.state.videoId === "string" ? context.state.videoId : null);
    if (known) return statusForVideo(context, known);
    const session = sessionOf(context);
    if (!session) throw new ProviderError("youtube_session", "缺少 YouTube 续传会话。", { definite: true });
    const video = videoOf(context);
    let offset = typeof context.state.uploadedBytes === "number" ? context.state.uploadedBytes : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= video.bytes) {
      throw new ProviderError("youtube_session_offset", "YouTube 续传位置无效。", { definite: true });
    }

    while (offset < video.bytes) {
      const end = Math.min(video.bytes, offset + chunkBytes) - 1;
      const isFinal = end === video.bytes - 1;
      const body = await video.stream(offset, end);
      if (isFinal) await context.beginSubmission();
      const response = await platformFetch(session, {
        method: "PUT", duplex: "half", timeoutMs: 120_000, body,
        headers: {
          ...bearer(context.credentials.accessToken), "Content-Type": video.mime,
          "Content-Length": String(end - offset + 1), "Content-Range": `bytes ${offset}-${end}/${video.bytes}`,
        },
      }, [308]);
      const result = await uploadResult(response, video.bytes);
      if (result.complete) {
        await checkpointVideo(context, result.id);
        return { kind: "pending", externalId: result.id, pollInMs: pendingPoll };
      }
      if (result.offset <= offset) {
        throw new ProviderError("youtube_upload_stalled", "YouTube 上传未取得进展，需要核对续传位置。", { retryable: true });
      }
      offset = result.offset;
      await context.checkpoint({ ...context.state, sessionUrl: session, uploadedBytes: offset });
      if (isFinal) return { kind: "pending", pollInMs: pendingPoll };
    }
    throw new ProviderError("youtube_upload_range", "不能确定 YouTube 上传进度。", { retryable: true });
  },
  async queryStatus(context): Promise<StatusOutcome> {
    const known = context.externalId ?? (typeof context.state.videoId === "string" ? context.state.videoId : null);
    if (known) return statusForVideo(context, known);
    const session = sessionOf(context);
    if (!session) return { kind: "unknown" };
    const size = videoOf(context).bytes;
    const response = await platformFetch(session, {
      method: "PUT",
      headers: { ...bearer(context.credentials.accessToken), "Content-Length": "0", "Content-Range": `bytes */${size}` },
    }, [308, 404, 410]);
    if (response.status === 404 || response.status === 410) return { kind: "unknown" };
    const result = await uploadResult(response, size);
    if (result.complete) {
      await checkpointVideo(context, result.id);
      return statusForVideo(context, result.id);
    }
    await context.checkpoint({ ...context.state, sessionUrl: session, uploadedBytes: result.offset });
    return { kind: "safe-to-resume" };
  },
};
