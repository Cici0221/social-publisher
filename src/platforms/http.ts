import { createHash } from "node:crypto";
import { ProviderError } from "./types";

type RequestOptions = RequestInit & { duplex?: "half"; timeoutMs?: number };

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ProviderError("configuration", "平台应用凭据未配置。", { definite: true });
  return value;
}

export function envAvailable(...names: string[]) {
  return names.every(name => Boolean(process.env[name]?.trim()))
    ? { available: true }
    : { available: false, reason: "平台开发者应用凭据尚未配置。" };
}

export function pkce(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function endpoint(url: string, params: Record<string, string | number | boolean | null | undefined> = {}): string {
  const result = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) result.searchParams.set(key, String(value));
  }
  return result.href;
}

export function form(data: Record<string, string | number | boolean | null | undefined>): URLSearchParams {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) result.set(key, String(value));
  }
  return result;
}

export function bearer(token: string) {
  return { Authorization: "Bearer " + token };
}

export function jsonBody(value: unknown, headers: Record<string, string> = {}): RequestInit {
  return { headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) };
}

export function expiresIn(seconds: unknown): string | undefined {
  const duration = Number(seconds);
  return Number.isFinite(duration) && duration > 0 ? new Date(Date.now() + duration * 1000).toISOString() : undefined;
}

export function assertUpstreamUrl(raw: string, hosts: readonly string[]): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    throw new ProviderError("unexpected_endpoint", "平台返回的媒体地址无效。", { definite: true });
  }
  if (parsed.protocol !== "https:" || !!parsed.username || !!parsed.password || !!parsed.port ||
      !hosts.some(host => parsed.hostname === host || (host.startsWith(".") && parsed.hostname.endsWith(host)))) {
    throw new ProviderError("unexpected_endpoint", "平台返回的媒体地址不在官方 HTTPS 范围内。", { definite: true });
  }
  return parsed.href;
}

export async function platformFetch(url: string, init: RequestOptions = {}, allowed: number[] = []): Promise<Response> {
  if (!url.startsWith("https://")) throw new ProviderError("invalid_protocol", "拒绝通过非 HTTPS 连接调用平台。", { definite: true });
  const { timeoutMs = 60_000, ...request } = init;
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs), ...request });
  } catch {
    throw new ProviderError("network", "平台接口连接中断或超时。", { retryable: true });
  }
  if (response.ok || allowed.includes(response.status)) return response;
  const status = response.status;
  if (status === 401) throw new ProviderError("authorization", "平台账号授权已失效。", { definite: true, reauth: true });
  if (status === 429) {
    const retry = response.headers.get("retry-after");
    const milliseconds = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : NaN;
    throw new ProviderError("rate_limit", "平台接口限流，请稍后重试。", {
      definite: true, retryable: true, retryAfterMs: Number.isFinite(milliseconds) ? Math.max(1000, milliseconds) : undefined,
    });
  }
  if (status >= 500 || status === 408) throw new ProviderError("platform_" + status, "平台接口暂时不可用。", { retryable: true });
  throw new ProviderError("platform_" + status, "平台拒绝此次请求。请检查授权、接口配额或内容要求。", { definite: true });
}

export async function readJson<T>(response: Response): Promise<T> {
  try { return await response.json() as T; } catch {
    throw new ProviderError("invalid_response", "平台未返回可识别的结果。", { retryable: true });
  }
}

export async function platformJson<T>(url: string, init: RequestOptions = {}): Promise<T> {
  return readJson<T>(await platformFetch(url, init));
}
