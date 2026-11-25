import { assertUpstreamUrl, endpoint, expiresIn, platformJson, requireEnv } from "../http";
import { type Credentials, type PlatformAdapter, ProviderError } from "../types";

const api = "https://open.kuaishou.com";
const requiredScopes = ["user_video_publish", "user_video_info"];
const appId = () => requireEnv("KUAISHOU_APP_ID");
const reason = "快手官方视频上传文档当前只说明 HTTP 网关。请先取得快手官方 HTTPS 上传接口说明。";

type KwaiResponse = { result?: number };
type TokenResponse = KwaiResponse & {
  access_token?: string; refresh_token?: string; open_id?: string; expires_in?: number;
  refresh_token_expires_in?: number; scopes?: string[]; error_msg?: string;
};
type PhotoResponse = KwaiResponse & {
  video_info?: { photo_id?: string; pending?: boolean; play_url?: string };
};

function gatewayUnavailable(): never {
  throw new ProviderError("kuaishou_upload_tls", reason, { definite: true });
}

function inspect<T extends KwaiResponse>(data: T): T {
  if (data?.result === 1) return data;
  if (data?.result === 120003 || data?.result === 100120003) {
    throw new ProviderError("kuaishou_rejected", "快手未能发布这个作品。", { definite: true });
  }
  throw new ProviderError("kuaishou_response", "快手拒绝请求，请检查账号授权及接口权限。", { definite: true });
}

async function getTokens(fields: { code: string } | { refresh_token: string }) {
  const refreshing = "refresh_token" in fields;
  const response = await platformJson<TokenResponse>(endpoint(
    api + (refreshing ? "/oauth2/refresh_token" : "/oauth2/access_token"), {
      app_id: appId(), app_secret: requireEnv("KUAISHOU_APP_SECRET"),
      grant_type: refreshing ? "refresh_token" : "authorization_code", ...fields,
    }));
  if (response.error_msg === "refreshToken.discarded") {
    throw new ProviderError("kuaishou_reauth", "快手续期凭据已失效，请重新授权。", { definite: true, reauth: true });
  }
  const { access_token, refresh_token, open_id, expires_in, refresh_token_expires_in, scopes } = inspect(response);
  if (!access_token || !refresh_token || !scopes || requiredScopes.some(scope => !scopes.includes(scope))) {
    throw new ProviderError("kuaishou_scope", "请授予快手账号的发布和作品查询权限。", { definite: true, reauth: true });
  }
  return { accessToken: access_token, refreshToken: refresh_token, openId: open_id,
    expiresAt: expiresIn(expires_in), refreshExpiresAt: expiresIn(refresh_token_expires_in) };
}

function accountQuery(credentials: Credentials) {
  return { access_token: credentials.accessToken, app_id: appId() };
}

export const kuaishouAdapter: PlatformAdapter = {
  key: "kuaishou",
  availability: () => ({ available: false, reason }),
  authorize: ({ redirectUri, state }) => endpoint(api + "/oauth2/authorize", {
    app_id: appId(), redirect_uri: redirectUri, response_type: "code", scope: requiredScopes.join(","), state, ua: "pc",
  }),
  exchange: async ({ code }) => {
    const { openId, ...token } = await getTokens({ code });
    if (!openId) throw new ProviderError("kuaishou_identity", "快手未返回用户标识。", { definite: true });
    return [{ ...token, externalId: openId, accountName: "快手账号 " + openId.slice(-6) }];
  },
  refresh: async credentials => {
    if (!credentials.refreshToken ||
      (credentials.refreshExpiresAt && Date.parse(credentials.refreshExpiresAt) <= Date.now())) return null;
    const { openId, ...token } = await getTokens({ refresh_token: credentials.refreshToken });
    if (openId && openId !== credentials.externalId) {
      throw new ProviderError("kuaishou_identity", "快手续期返回了其他账号。", { definite: true, reauth: true });
    }
    return { ...credentials, ...token };
  },
  verify: async credentials => {
    inspect(await platformJson<KwaiResponse>(endpoint(api + "/openapi/photo/count", accountQuery(credentials))));
  },
  validate: async () => gatewayUnavailable(),
  uploadMedia: async () => gatewayUnavailable(),
  publish: async () => gatewayUnavailable(),
  queryStatus: async context => {
    if (!context.externalId) return { kind: "unknown" };
    const id = context.externalId;
    const status = await platformJson<PhotoResponse>(endpoint(api + "/openapi/photo/info", {
      ...accountQuery(context.credentials), photo_id: id,
    }));
    if (status.result === 120001 || status.result === 100120001) return { kind: "pending", externalId: id, pollInMs: 120_000 };
    const row = inspect(status).video_info;
    if (row?.photo_id === id && row.pending === false && row.play_url) {
      const url = assertUpstreamUrl(row.play_url, [".kuaishou.com", ".kwai.com", ".gifshow.com", ".kwaicdn.com"]);
      return { kind: "success", externalId: id, url };
    }
    return { kind: "pending", externalId: id, pollInMs: 120_000 };
  },
};
