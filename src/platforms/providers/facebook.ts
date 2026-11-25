import { randomUUID } from "node:crypto";
import { bearer, endpoint, envAvailable, expiresIn, form, requireEnv } from "../http";
import { ProviderError, type AdapterContext, type Credentials, type Media, type PlatformAdapter, type PublishOutcome } from "../types";
import { metaId, metaJson, metaVersion, officialPostUrl, publicMedia, type MetaToken } from "./meta-helpers";

const environment = ["FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"];
const scopes = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
const poll = 15_000;

type Accounts = { data?: Array<{ id?: string; name?: string; tasks?: string[]; access_token?: string }>; paging?: { cursors?: { after?: string }; next?: string } };
type TokenDebug = {
  data?: { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[] };
};
type VideoStatus = { id?: string; status?: { video_status?: string; publishing_phase?: { status?: string } }; permalink_url?: string };

function graph(path: string) {
  return "https://graph.facebook.com/" + metaVersion() + "/" + path;
}

function appId() { return requireEnv("FACEBOOK_CLIENT_ID"); }
function appSecret() { return requireEnv("FACEBOOK_CLIENT_SECRET"); }

async function token(parameters: Record<string, string>) {
  const result = await metaJson<MetaToken>(endpoint(graph("oauth/access_token"), {
    ...parameters, client_id: appId(), client_secret: appSecret(),
  }));
  if (!result.access_token) throw new ProviderError("facebook_token", "Facebook 未返回访问令牌。", { definite: true });
  return { ...result, access_token: result.access_token };
}

async function pageTokenInfo(accessToken: string) {
  const result = await metaJson<TokenDebug>(endpoint(graph("debug_token"), {
    input_token: accessToken,
  }), { headers: bearer(appId() + "|" + appSecret()) });
  return result.data;
}

function pageExpiry(debug: NonNullable<TokenDebug["data"]> | undefined): string | undefined {
  const candidates = [debug?.expires_at, debug?.data_access_expires_at]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return candidates.length ? new Date(Math.min(...candidates) * 1000).toISOString() : undefined;
}

async function pages(userToken: string) {
  const result: NonNullable<Accounts["data"]> = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page: Accounts = await metaJson<Accounts>(endpoint(graph("me/accounts"), {
      fields: "id,name,tasks,access_token", limit: 100, after: cursor,
    }), { headers: bearer(userToken) });
    result.push(...(page.data ?? []));
    cursor = page.paging?.next ? page.paging.cursors?.after : undefined;
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
  return result;
}

function pageCanPublish(tasks?: string[]) {
  return tasks?.includes("CREATE_CONTENT") === true || tasks?.includes("PROFILE_PLUS_CREATE_CONTENT") === true;
}

function hasStateId(value: unknown): value is string {
  return typeof value === "string";
}

async function multipartAsset(fields: Record<string, string>, name: string, media: Media) {
  const boundary = "publisher-" + randomUUID();
  const intro = Buffer.from(Object.entries(fields).map(([key, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join("") +
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="asset"\r\nContent-Type: ${media.mime}\r\n\r\n`);
  const outro = Buffer.from(`\r\n--${boundary}--\r\n`);
  const reader = (await media.stream()).getReader();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(intro); },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        reader.releaseLock();
        controller.enqueue(outro);
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return {
    method: "POST", duplex: "half" as const, body: stream, timeoutMs: 120_000,
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(intro.length + media.bytes + outro.length) },
  };
}

async function knownPost(context: AdapterContext, id: string): Promise<PublishOutcome> {
  const result = await metaJson<{ permalink_url?: string }>(endpoint(graph(metaId(id)), { fields: "id,permalink_url" }), {
    headers: bearer(context.credentials.accessToken),
  });
  return { kind: "success", externalId: id, url: officialPostUrl(result.permalink_url, "facebook.com") };
}

async function knownVideo(context: AdapterContext, id: string): Promise<PublishOutcome> {
  const result = await metaJson<VideoStatus>(endpoint(graph(metaId(id)), { fields: "id,status,permalink_url" }), {
    headers: bearer(context.credentials.accessToken),
  });
  const state = result.status?.video_status;
  const publishing = result.status?.publishing_phase?.status;
  if (state === "error" || publishing === "error") {
    throw new ProviderError("post_rejected", "Facebook 未能完成视频处理或发布。", { definite: true });
  }
  if (state !== "ready" || (publishing !== undefined && publishing !== "complete")) {
    return { kind: "pending", externalId: id, pollInMs: poll };
  }
  return { kind: "success", externalId: id, url: officialPostUrl(result.permalink_url, "facebook.com") };
}

export const facebook: PlatformAdapter = {
  key: "facebook",
  availability: () => envAvailable(...environment),
  authorize: input => endpoint(`https://www.facebook.com/${metaVersion()}/dialog/oauth`, {
    client_id: appId(), redirect_uri: input.redirectUri, state: input.state, response_type: "code", scope: scopes.join(","),
  }),
  async exchange(input) {
    const short = await token({ code: input.code, redirect_uri: input.redirectUri });
    const long = await token({ grant_type: "fb_exchange_token", fb_exchange_token: short.access_token });
    const accounts = (await pages(long.access_token)).filter(item => item.id && item.name && item.access_token && pageCanPublish(item.tasks));
    const credentials: Credentials[] = [];
    for (const account of accounts) {
      const accessToken = account.access_token!;
      const details = await pageTokenInfo(accessToken);
      if (details?.is_valid === false) continue;
      credentials.push({
        externalId: metaId(account.id), accountName: account.name!, accessToken,
        refreshToken: long.access_token, expiresAt: pageExpiry(details), refreshExpiresAt: expiresIn(long.expires_in),
      });
    }
    if (!credentials.length) throw new ProviderError("facebook_no_pages", "没有可授权且允许创建内容的 Facebook 公共主页。", { definite: true });
    return credentials;
  },
  async refresh(credentials) {
    try {
      const current = await pageTokenInfo(credentials.accessToken);
      const currentExpiry = pageExpiry(current);
      if (current?.is_valid && (!currentExpiry || Date.parse(currentExpiry) > Date.now() + 7 * 86_400_000)) {
        return { ...credentials, expiresAt: currentExpiry };
      }
    } catch (error) {
      if (!(error instanceof ProviderError && error.options.reauth)) throw error;
    }

    if (!credentials.refreshToken || (credentials.refreshExpiresAt && Date.parse(credentials.refreshExpiresAt) <= Date.now())) return null;
    try {
      const page = (await pages(credentials.refreshToken)).find(row => row.id === credentials.externalId && pageCanPublish(row.tasks));
      if (!page?.access_token) return null;
      const details = await pageTokenInfo(page.access_token);
      const expiresAt = pageExpiry(details);
      if (!details?.is_valid || (expiresAt && Date.parse(expiresAt) <= Date.now() + 7 * 86_400_000)) return null;
      return { ...credentials, accountName: page.name ?? credentials.accountName, accessToken: page.access_token, expiresAt };
    } catch (error) {
      if (error instanceof ProviderError && error.options.reauth) return null;
      throw error;
    }
  },
  async verify(credentials) {
    const info = await pageTokenInfo(credentials.accessToken);
    if (!info?.is_valid || (info.scopes && !info.scopes.includes("pages_manage_posts"))) {
      throw new ProviderError("facebook_auth", "此 Facebook 公共主页授权无效或缺少发布权限。", { definite: true, reauth: true });
    }
    const page = await metaJson<{ id?: string }>(endpoint(graph("me"), { fields: "id" }), { headers: bearer(credentials.accessToken) });
    if (page.id !== credentials.externalId) {
      throw new ProviderError("facebook_page_mismatch", "Facebook 令牌与已经绑定的公共主页不匹配。", { definite: true, reauth: true });
    }
  },
  async validate(context) {
    const isVideo = context.media.some(media => media.kind === "VIDEO");
    if (context.cover && !isVideo) throw new ProviderError("facebook_cover", "Facebook 视频封面需要同时选择视频。", { definite: true });
  },
  async uploadMedia(context) {
    if (context.media.some(media => media.kind === "VIDEO") || !context.media.length) return { kind: "ready" };
    const page = metaId(context.credentials.externalId, false);
    const mediaIds = context.state.photoIds && typeof context.state.photoIds === "object"
      ? { ...context.state.photoIds } as Record<string, string> : {};
    for (const media of context.media) {
      if (hasStateId(mediaIds[media.id])) continue;
      const request = await multipartAsset({ published: "false" }, "source", media);
      const result = await metaJson<{ id?: string }>(graph(page + "/photos"), {
        ...request, headers: { ...bearer(context.credentials.accessToken), ...request.headers },
      });
      mediaIds[media.id] = metaId(result.id);
      await context.checkpoint({ ...context.state, photoIds: mediaIds });
    }
    return { kind: "ready" };
  },
  async publish(context) {
    const knownId = context.externalId ?? (hasStateId(context.state.postId) ? context.state.postId : undefined);
    const video = context.media.find(media => media.kind === "VIDEO");
    if (knownId) return video ? knownVideo(context, knownId) : knownPost(context, knownId);
    const page = metaId(context.credentials.externalId, false);
    const authorization = bearer(context.credentials.accessToken);
    const message = context.payload.body;
    if (video) {
      const filename = await publicMedia(video);
      const fields = { file_url: filename, title: context.payload.title, description: message, published: "true" };
      const request = context.cover
        ? await multipartAsset(fields, "thumb", context.cover)
        : { method: "POST", body: form(fields) };
      const headers = { ...authorization, ...("headers" in request ? request.headers : {}) };
      const url = `https://graph-video.facebook.com/${metaVersion()}/${page}/videos`;
      await context.beginSubmission();
      const result = await metaJson<{ id?: string }>(url, { ...request, headers });
      const id = metaId(result.id);
      await context.checkpoint({ ...context.state, postId: id });
      return { kind: "pending", externalId: id, pollInMs: poll };
    }

    const photoIds = context.state.photoIds as Record<string, unknown> | undefined;
    const body = form({ message });
    for (const [index, media] of context.media.entries()) {
      body.set(`attached_media[${index}]`, JSON.stringify({ media_fbid: metaId(photoIds?.[media.id], false) }));
    }
    const url = graph(page + "/feed");
    await context.beginSubmission();
    const result = await metaJson<{ id?: string }>(url, { method: "POST", body, headers: authorization });
    const id = metaId(result.id);
    await context.checkpoint({ ...context.state, postId: id });
    return { kind: "pending", externalId: id, pollInMs: poll };
  },
  async queryStatus(context) {
    const id = context.externalId ?? (hasStateId(context.state.postId) ? context.state.postId : undefined);
    if (!id) return { kind: "unknown" };
    return context.media.some(media => media.kind === "VIDEO") ? knownVideo(context, id) : knownPost(context, id);
  },
};
