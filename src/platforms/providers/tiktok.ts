import { ProviderError, type PlatformAdapter } from "../types";

const reason = "TikTok 官方 Direct Post 不接受仅供团队管理自有账号的内部工具。此平台仅支持模拟发布。";

async function unavailable(): Promise<never> {
  throw new ProviderError("tiktok_internal_use", reason, { definite: true });
}

export const tiktok: PlatformAdapter = {
  key: "tiktok",
  availability: () => ({ available: false, reason }),
  refresh: async () => null,
  verify: unavailable,
  validate: unavailable,
  uploadMedia: unavailable,
  publish: unavailable,
  queryStatus: async () => ({ kind: "unknown" }),
};
