import { endpoint, envAvailable, expiresIn, form, requireEnv } from "../http";
import { ProviderError, type AdapterContext, type Media, type PlatformAdapter, type PublishOutcome } from "../types";
import { metaId, metaJson, type MetaToken, officialPostUrl, publicMedia, tokenEndpoint, tokenExpiry } from "./meta-helpers";

const host = "https://graph.threads.com";
const environment = ["THREADS_CLIENT_ID", "THREADS_CLIENT_SECRET"];
const scopes = ["threads_basic", "threads_content_publish"];
const processingDelay = 30_000;
const poll = 60_000;
const pollWindow = 5 * poll;
const daySeconds = 24 * 3600;
const tokenLifetime = 60 * daySeconds;
const grantLifetime = 90 * daySeconds;

function elapsed(start: unknown) {
  return typeof start === "number" && Date.now() - start > pollWindow;
}

type Container = { id?: string; status?: string };

function graph(path: string): string { return host + "/v1.0/" + path; }
function stateString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

async function account(accessToken: string) {
  const profile = await metaJson<{ id?: string; username?: string }>(endpoint(graph("me"), {
    fields: "id,username", access_token: accessToken,
  }));
  if (!profile.username) throw new ProviderError("threads_account", "Threads 授权未返回可用账号。", { definite: true, reauth: true });
  return { externalId: metaId(profile.id, false), accountName: profile.username };
}

async function createContainer(context: AdapterContext, data: Record<string, string | boolean | undefined>) {
  const user = metaId(context.credentials.externalId, false);
  const result = await metaJson<Container>(graph(user + "/threads"), {
    method: "POST", body: form({ ...data, access_token: context.credentials.accessToken }),
  });
  return metaId(result.id);
}

async function containerStatus(id: string, accessToken: string) {
  const result = await metaJson<Container>(endpoint(graph(metaId(id)), { fields: "status", access_token: accessToken }));
  if (result.status === "ERROR" || result.status === "EXPIRED") {
    throw new ProviderError("post_rejected", result.status === "EXPIRED" ? "Threads 素材容器已过期。" : "Threads 未能处理此素材，请检查文件格式和网络可达性。", { definite: true });
  }
  return result.status;
}

async function assetParameters(media: Media) {
  const url = await publicMedia(media);
  return media.kind === "VIDEO" ? { video_url: url, media_type: "VIDEO" } : { image_url: url, media_type: "IMAGE" };
}

async function confirmedPost(context: AdapterContext, id: string): Promise<PublishOutcome> {
  let url: string | undefined;
  try {
    const result = await metaJson<{ permalink?: string }>(endpoint(graph(metaId(id)), {
      fields: "id,permalink", access_token: context.credentials.accessToken,
    }));
    url = officialPostUrl(result.permalink, "threads.com") ?? officialPostUrl(result.permalink, "threads.net");
  } catch (error) {
    if (!(error instanceof ProviderError && error.options.definite && !error.options.retryable)) throw error;
  }
  return { kind: "success", externalId: id, url };
}

export const threads: PlatformAdapter = {
  key: "threads",
  availability: () => envAvailable(...environment),
  authorize: input => endpoint("https://threads.com/oauth/authorize", {
    client_id: requireEnv("THREADS_CLIENT_ID"), redirect_uri: input.redirectUri,
    response_type: "code", scope: scopes.join(","), state: input.state,
  }),
  async exchange(input) {
    const secret = requireEnv("THREADS_CLIENT_SECRET");
    const body = new FormData();
    const fields = {
      client_id: requireEnv("THREADS_CLIENT_ID"), client_secret: secret,
      redirect_uri: input.redirectUri, grant_type: "authorization_code", code: input.code,
    };
    for (const [name, value] of Object.entries(fields)) body.set(name, value);
    const temporary = await metaJson<MetaToken>(host + "/oauth/access_token", { method: "POST", body });
    if (!temporary.access_token) throw new ProviderError("threads_token", "Threads 未返回访问令牌。", { definite: true });
    const extended = await metaJson<MetaToken>(tokenEndpoint(host + "/access_token", temporary.access_token, "th_exchange_token", secret));
    if (!extended.access_token) throw new ProviderError("threads_token", "Threads 未返回长期访问令牌。", { definite: true });
    return [{
      ...await account(extended.access_token),
      accessToken: extended.access_token,
      expiresAt: tokenExpiry(extended, tokenLifetime),
      refreshExpiresAt: expiresIn(grantLifetime),
    }];
  },
  async refresh(credentials) {
    if (credentials.expiresAt && Date.parse(credentials.expiresAt) <= Date.now()) return null;
    // Meta renews the permission grant for public profiles only. The profile response
    // does not verify visibility, so schedule re-authorization from the original grant.
    const grantCutoff = credentials.refreshExpiresAt;
    if (grantCutoff && Date.parse(grantCutoff) <= Date.now() + 7 * daySeconds * 1000) return null;
    try {
      const result = await metaJson<MetaToken>(tokenEndpoint(host + "/refresh_access_token", credentials.accessToken, "th_refresh_token"));
      if (!result.access_token) return null;
      const tokenCutoff = tokenExpiry(result, tokenLifetime);
      const expiresAt = grantCutoff && tokenCutoff && Date.parse(grantCutoff) < Date.parse(tokenCutoff) ? grantCutoff : tokenCutoff;
      return { ...credentials, accessToken: result.access_token, expiresAt };
    } catch (error) {
      if (error instanceof ProviderError && (error.options.reauth || (error.options.definite && !error.options.retryable))) return null;
      throw error;
    }
  },
  async verify(credentials) {
    const profile = await account(credentials.accessToken);
    if (profile.externalId !== credentials.externalId) {
      throw new ProviderError("threads_account", "Threads 令牌与已绑定的账号不匹配。", { definite: true, reauth: true });
    }
  },
  async uploadMedia(context) {
    if (context.externalId || stateString(context.state.postId)) return { kind: "ready" };
    const token = context.credentials.accessToken;
    const text = context.payload.body;
    let containerId = stateString(context.state.containerId);
    const children = context.state.carouselIds && typeof context.state.carouselIds === "object"
      ? { ...context.state.carouselIds } as Record<string, string> : {};
    if (!containerId && context.media.length > 1) {
      for (const media of context.media) {
        if (children[media.id]) continue;
        children[media.id] = await createContainer(context, { ...await assetParameters(media), is_carousel_item: true });
        await context.checkpoint({ ...context.state, carouselIds: children });
      }
      const ids = context.media.map(media => children[media.id]);
      const statuses = await Promise.all(ids.map(id => containerStatus(id, token)));
      if (statuses.some(status => status !== "FINISHED")) return { kind: "pending", pollInMs: processingDelay };
      containerId = await createContainer(context, { media_type: "CAROUSEL", children: ids.join(","), text });
    }
    if (!containerId) {
      const [media] = context.media;
      const data = media ? await assetParameters(media) : { media_type: "TEXT" };
      containerId = await createContainer(context, { ...data, text });
    }
    if (containerId !== context.state.containerId) {
      await context.checkpoint({ ...context.state, carouselIds: children, containerId, readyAt: Date.now() + processingDelay });
      return { kind: "pending", pollInMs: processingDelay };
    }
    const delay = typeof context.state.readyAt === "number" ? context.state.readyAt - Date.now() : 0;
    if (delay > 0) return { kind: "pending", pollInMs: Math.max(1000, delay) };
    if (elapsed(context.state.readyAt)) {
      throw new ProviderError("threads_timeout", "Threads 未在建议的查询时间内完成素材处理。", { definite: true });
    }
    const status = await containerStatus(containerId, token);
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
    if (status !== "FINISHED") throw new ProviderError("threads_not_ready", "Threads 素材尚未处理完成。", { retryable: true });
    const request = {
      method: "POST",
      body: form({ creation_id: containerId, access_token: context.credentials.accessToken }),
    };
    await context.checkpoint({ ...context.state, submissionStartedAt: Date.now() });
    await context.beginSubmission();
    const result = await metaJson<Container>(graph(user + "/threads_publish"), request);
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
