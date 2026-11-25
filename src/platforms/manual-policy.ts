import { platformRules, type PlatformKey } from "@/lib/platforms";
import type { PlatformAdapter } from "./types";

export const manualPolicies = {
  xiaohongshu: { backendHosts: ["creator.xiaohongshu.com"], postHosts: ["www.xiaohongshu.com", "xiaohongshu.com", "xhslink.com"] },
  wechat: { backendHosts: ["channels.weixin.qq.com"], postHosts: ["channels.weixin.qq.com", "weixin.qq.com"] },
} as const;

export type ManualPlatformKey = keyof typeof manualPolicies;
export function isManualPlatform(value: string): value is ManualPlatformKey {
  return Object.hasOwn(manualPolicies, value);
}

export function manualUrl(key: ManualPlatformKey, input: string, use: "backend" | "post"): string | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  const policy = manualPolicies[key];
  const hosts: readonly string[] = use === "backend" ? policy.backendHosts : policy.postHosts;
  if (!hosts.includes(url.hostname)) return null;
  if (use === "backend" && (url.search || url.hash)) return null;
  if (use === "post" && (!url.pathname || url.pathname === "/" || policy.backendHosts.some(host => host === url.hostname) && url.pathname.startsWith("/platform"))) return null;
  return url.href;
}

export function manualBackend(key: ManualPlatformKey, value?: string | null) {
  return manualUrl(key, value || platformRules[key].backend || "", "backend");
}

export function manualAdapter(key: ManualPlatformKey & PlatformKey): PlatformAdapter {
  return {
    key,
    availability: () => ({ available: true }),
    refresh: async () => null,
    verify: async () => {},
    uploadMedia: async () => ({ kind: "ready" }),
    publish: async () => ({ kind: "manual" }),
    queryStatus: async () => ({ kind: "manual" }),
  };
}
