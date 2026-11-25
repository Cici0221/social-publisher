import { endpoint, envAvailable, form, requireEnv } from "../http";
import { ProviderError, type AdapterContext, type Media, type PlatformAdapter, type PublishOutcome } from "../types";
import { metaId, metaJson, type MetaToken, metaVersion, officialPostUrl, publicMedia, tokenEndpoint, tokenExpiry } from "./meta-helpers";

const environment = ["INSTAGRAM_CLIENT_ID", "INSTAGRAM_CLIENT_SECRET"];
const tokenHost = "https://graph.instagram.com";
const scopes = ["instagram_business_basic", "instagram_business_content_publish"];
const poll = 60_000;
const pollWindow = 5 * poll;
const tokenLifetime = 60 * 24 * 3600;

type Account = { user_id?: string; username?: string };
function elapsed(start: unknown) {
  return typeof start === "number" && Date.now() - start > pollWindow;
}

type Container = { id?: string; status_code?: string };

function graph(path: string) { return tokenHost + "/" + metaVersion() + "/" + path; }

async function account(accessToken: string) {
  const result = await metaJson<Account & { data?: Account[] }>(endpoint(graph("me"), {
    fields: "user_id,username", access_token: accessToken,
  }));
  const profile = result.data?.[0] ?? result;
  if (!profile.user_id || !profile.username) {
    throw new ProviderError("instagram_account", "授权未返回可用的 Instagram 专业账号。", { definite: true, reauth: true });
  }
  return { externalId: metaId(profile.user_id, false), accountName: profile.username };
}

async function containerStatus(id: string, accessToken: string) {
  const result = await metaJson<Container>(endpoint(graph(metaId(id)), { fields: "status_code", access_token: accessToken }));
  if (result.status_code === "ERROR" || result.status_code === "EXPIRED") {
    throw new ProviderError("post_rejected", result.status_code === "EXPIRED" ? "Instagram 素材容器已过期。" : "Instagram 未能处理此素材，请检查文件格式和网络可达性。", { definite: true });
  }
  return result.status_code;
}

async function createContainer(context: AdapterContext, data: Record<string, string | boolean | undefined>) {
  const user = metaId(context.credentials.externalId, false);
  const container = await metaJson<Container>(graph(user + "/media"), {
    method: "POST", body: form({ ...data, access_token: context.credentials.accessToken }),
  });
  return metaId(container.id);
}

async function assetParameters(media: Media, child: boolean) {
  const url = await publicMedia(media);
  return media.kind === "VIDEO"
    ? { video_url: url, media_type: child ? "VIDEO" : "REELS" }
    : { image_url: url };
}

function stateString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function confirmedPost(context: AdapterContext, id: string): Promise<PublishOutcome> {
  let permalink: string | undefined;
  try {
    const media = await metaJson<{ permalink?: string }>(endpoint(graph(metaId(id)), {
      fields: "id,permalink", access_token: context.credentials.accessToken,
    }));
    permalink = officialPostUrl(media.permalink, "instagram.com");
  } catch (error) {
    if (!(error instanceof ProviderError && error.options.definite && !error.options.retryable)) throw error;
  }
  return { kind: "success", externalId: id, url: permalink };
}

export const instagram: PlatformAdapter = {
  key: "instagram",
  availability: () => envAvailable(...environment),
  authorize: input => endpoint("https://www.instagram.com/oauth/authorize", {
    client_id: requireEnv("INSTAGRAM_CLIENT_ID"), redirect_uri: input.redirectUri,
    response_type: "code", scope: scopes.join(","), state: input.state,
  }),
  async exchange(input) {
    const clientSecret = requireEnv("INSTAGRAM_CLIENT_SECRET");
    const body = new FormData();
    const fields = {
      client_id: requireEnv("INSTAGRAM_CLIENT_ID"), client_secret: clientSecret,
      grant_type: "authorization_code", redirect_uri: input.redirectUri, code: input.code,
    };
    for (const [name, value] of Object.entries(fields)) body.set(name, value);
    const temporary = await metaJson<MetaToken>("https://api.instagram.com/oauth/access_token", { method: "POST", body });
    if (!temporary.access_token) throw new ProviderError("instagram_token", "Instagram 未返回访问令牌。", { definite: true });
    const extended = await metaJson<MetaToken>(tokenEndpoint(tokenHost + "/access_token", temporary.access_token, "ig_exchange_token", clientSecret));
    if (!extended.access_token) throw new ProviderError("instagram_token", "Instagram 未返回长期访问令牌。", { definite: true });
    return [{ ...await account(extended.access_token), accessToken: extended.access_token, expiresAt: tokenExpiry(extended, tokenLifetime) }];
  },
  async refresh(credentials) {
    if (credentials.expiresAt && Date.parse(credentials.expiresAt) <= Date.now()) return null;
    try {
      const result = await metaJson<MetaToken>(tokenEndpoint(tokenHost + "/refresh_access_token", credentials.accessToken, "ig_refresh_token"));
      return result.access_token ? { ...credentials, accessToken: result.access_token, expiresAt: tokenExpiry(result, tokenLifetime) } : null;
    } catch (error) {
      if (error instanceof ProviderError && (error.options.reauth || (error.options.definite && !error.options.retryable))) return null;
      throw error;
    }
  },
  async verify(credentials) {
    const profile = await account(credentials.accessToken);
    if (profile.externalId !== credentials.externalId) {
      throw new ProviderError("instagram_account", "Instagram 令牌与已绑定的专业账号不匹配。", { definite: true, reauth: true });
    }
  },
  async validate(context) {
    if (!context.media.length) throw new ProviderError("instagram_requires_media", "Instagram 发布需要图片或视频。", { definite: true });
    if (context.cover && (context.media.length !== 1 || context.media[0].kind !== "VIDEO")) {
      throw new ProviderError("instagram_cover", "Instagram 仅支持为单条 Reel 指定视频封面。", { definite: true });
    }
  },
  async uploadMedia(context) {
    if (context.externalId || stateString(context.state.postId)) return { kind: "ready" };
    const accessToken = context.credentials.accessToken;
    const caption = context.payload.body;
    const carousel = context.media.length > 1;
    let containerId = stateString(context.state.containerId);
    const children = context.state.carouselIds && typeof context.state.carouselIds === "object"
      ? { ...context.state.carouselIds } as Record<string, string> : {};

    if (!containerId && carousel) {
      for (const media of context.media) {
        if (children[media.id]) continue;
        children[media.id] = await createContainer(context, { ...await assetParameters(media, true), is_carousel_item: true });
        await context.checkpoint({ ...context.state, carouselIds: children });
      }
      const ids = context.media.map(media => children[media.id]);
      const statuses = await Promise.all(ids.map(id => containerStatus(id, accessToken)));
      if (statuses.some(status => status !== "FINISHED")) return { kind: "pending", pollInMs: poll };
      containerId = await createContainer(context, { media_type: "CAROUSEL", children: ids.join(","), caption });
    }
    if (!containerId) {
      const [media] = context.media;
      if (!media) throw new ProviderError("instagram_requires_media", "Instagram 发布需要图片或视频。", { definite: true });
      containerId = await createContainer(context, {
        ...await assetParameters(media, false),
        caption,
        cover_url: context.cover ? await publicMedia(context.cover) : undefined,
      });
    }
    if (containerId !== context.state.containerId) {
      await context.checkpoint({ ...context.state, carouselIds: children, containerId, containerStartedAt: Date.now() });
    }
    if (elapsed(context.state.containerStartedAt)) {
      throw new ProviderError("instagram_timeout", "Instagram 未在建议的查询时间内完成素材处理。", { definite: true });
    }
    const status = await containerStatus(containerId, accessToken);
    if (status === "FINISHED" || status === "PUBLISHED") {
      await context.checkpoint({ ...context.state, containerReady: status });
      return { kind: "ready" };
    }
    return { kind: "pending", pollInMs: poll };
  },
  async publish(context) {
    const known = context.externalId ?? stateString(context.state.postId);
    if (known) return confirmedPost(context, known);
    const containerId = metaId(context.state.containerId, false);
    const user = metaId(context.credentials.externalId, false);
    const status = context.state.containerReady ?? await containerStatus(containerId, context.credentials.accessToken);
    if (status === "PUBLISHED") return { kind: "success", externalId: containerId };
    if (status !== "FINISHED") throw new ProviderError("instagram_not_ready", "Instagram 素材尚未处理完成。", { retryable: true });
    const request = {
      method: "POST",
      body: form({ creation_id: containerId, access_token: context.credentials.accessToken }),
    };
    await context.checkpoint({ ...context.state, submissionStartedAt: Date.now() });
    await context.beginSubmission();
    const result = await metaJson<Container>(graph(user + "/media_publish"), request);
    const id = metaId(result.id);
    await context.checkpoint({ ...context.state, postId: id });
    return { kind: "pending", externalId: id, pollInMs: 1000 };
  },
  async queryStatus(context) {
    const known = context.externalId ?? stateString(context.state.postId);
    if (known) return confirmedPost(context, known);
    const containerId = stateString(context.state.containerId);
    if (!containerId || elapsed(context.state.submissionStartedAt)) return { kind: "unknown" };
    const status = await containerStatus(containerId, context.credentials.accessToken);
    if (status === "PUBLISHED") return { kind: "success", externalId: containerId };
    if (status === "IN_PROGRESS") return { kind: "pending", pollInMs: poll };
    return { kind: "unknown" };
  },
};
