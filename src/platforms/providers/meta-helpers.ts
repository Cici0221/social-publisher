import { endpoint, expiresIn, platformFetch, readJson } from "../http";
import { ProviderError, type Media } from "../types";

type MetaError = {
  error?: { code?: number; is_transient?: boolean };
  error_type?: string;
  code?: number;
};

export type MetaToken = { access_token?: string; expires_in?: number };

export function metaVersion() {
  const value = process.env.META_GRAPH_VERSION?.trim() || "v27.0";
  if (!/^v[1-9]\d*\.\d+$/.test(value)) {
    throw new ProviderError("meta_version", "Meta Graph API 版本配置无效。", { definite: true });
  }
  return value;
}

export async function metaJson<T>(url: string, init: RequestInit & { duplex?: "half"; timeoutMs?: number } = {}): Promise<T> {
  const response = await platformFetch(url, init, [400, 403]);
  const result = await readJson<T & MetaError>(response);
  if (!result || typeof result !== "object") {
    throw new ProviderError("meta_response", "Meta 平台未返回可识别的响应。", { retryable: true });
  }
  const problem = result.error;
  if (!response.ok || problem || result.error_type) {
    const code = problem?.code ?? result.code ?? response.status;
    if (code === 190 || code === 102) {
      throw new ProviderError("meta_auth", "Meta 平台账号授权已过期或被撤销。", { definite: true, reauth: true });
    }
    if (code === 4 || code === 17 || code === 32 || code === 613) {
      throw new ProviderError("meta_limit", "Meta 平台接口限流，请稍后重试。", { definite: true, retryable: true });
    }
    if (problem?.is_transient) {
      throw new ProviderError("meta_temporary", "Meta 平台接口暂时不可用。", { retryable: true });
    }
    if (code === 10 || code === 200 || response.status === 403) {
      throw new ProviderError("meta_permissions", "Meta 平台未批准该操作，或此账号没有所需权限。", { definite: true });
    }
    throw new ProviderError("meta_rejected_" + (Number.isInteger(code) ? code : response.status), "Meta 平台拒绝了请求，请检查账户权限及内容规格。", { definite: true });
  }
  return result;
}

export function tokenExpiry(token: MetaToken, fallbackSeconds: number) {
  return expiresIn(token.expires_in) ?? expiresIn(fallbackSeconds);
}

export function metaId(value: unknown, retryable = true): string {
  if (typeof value !== "string" || !/^\d+(?:_\d+)?$/.test(value)) {
    throw new ProviderError("meta_missing_id", "Meta 平台未返回可用的对象编号。", { retryable, definite: !retryable });
  }
  return value;
}

export function officialPostUrl(value: unknown, domain: string): string | undefined {
  if (typeof value !== "string") return;
  const original = value.startsWith("/") ? "https://www." + domain + value : value;
  try {
    const url = new URL(original);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
        (url.hostname === domain || url.hostname.endsWith("." + domain))) return url.href;
  } catch {
    return;
  }
}

export async function publicMedia(media: Media): Promise<string> {
  let url: URL;
  try { url = new URL(await media.url(3600)); } catch {
    throw new ProviderError("meta_media_url", "无法为平台生成可读取的素材地址。", { definite: true });
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || hostname === "localhost" ||
      hostname.endsWith(".localhost") || hostname.endsWith(".local") || !hostname.includes(".") ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) {
    throw new ProviderError("meta_media_public", "请配置平台可访问的 HTTPS 对象存储地址（S3_PROVIDER_ENDPOINT）。", { definite: true });
  }
  return url.href;
}

export function tokenEndpoint(url: string, accessToken: string, grant_type: string, client_secret?: string) {
  return endpoint(url, { access_token: accessToken, grant_type, client_secret });
}
