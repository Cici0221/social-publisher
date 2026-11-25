import { platformRules, type PlatformKey } from "@/lib/platforms";
import { xiaohongshu } from "./providers/xiaohongshu";
import { wechat } from "./providers/wechat";
import { bluesky } from "./providers/bluesky";
import { youtube } from "./providers/youtube";
import { facebook } from "./providers/facebook";
import { instagram } from "./providers/instagram";
import { threads } from "./providers/threads";
import { linkedin } from "./providers/linkedin";
import { x } from "./providers/x";
import { tiktok } from "./providers/tiktok";
import { douyinAdapter as douyin } from "./providers/douyin";
import { weiboAdapter as weibo } from "./providers/weibo";
import { kuaishouAdapter as kuaishou } from "./providers/kuaishou";
import { bilibiliAdapter as bilibili } from "./providers/bilibili";
import { ProviderError, type PlatformAdapter, type Credentials } from "./types";

const manual: Partial<Record<PlatformKey, PlatformAdapter>> = { xiaohongshu, wechat };
const live: Partial<Record<PlatformKey, PlatformAdapter>> = { youtube, facebook, instagram, threads, linkedin, bluesky, x, tiktok, douyin, weibo, kuaishou, bilibili };

function simulated(key: PlatformKey): PlatformAdapter {
  return {
    key,
    availability: () => ({ available: true }),
    refresh: async (credentials: Credentials) => credentials,
    verify: async () => {},
    uploadMedia: async () => ({ kind: "ready" }),
    publish: async context => {
      if (process.env.APP_MODE === "local" && process.env.MOCK_FAIL_PLATFORM === key) {
        throw new ProviderError("mock_rejected", "模拟平台拒绝了此任务。", { definite: true });
      }
      return { kind: "success", externalId: "mock-" + context.taskId };
    },
    queryStatus: async context => ({ kind: "success", externalId: context.externalId ?? "mock-" + context.taskId }),
  };
}

function unavailable(key: PlatformKey): PlatformAdapter {
  const name = platformRules[key].label;
  const reason = name + " 的真实接入尚不可用。";
  const deny = async (): Promise<never> => { throw new ProviderError("unavailable", reason, { definite: true }); };
  return {
    key, availability: () => ({ available: false, reason }), refresh: async () => null, verify: deny,
    uploadMedia: deny, publish: deny, queryStatus: async () => ({ kind: "unknown" }),
  };
}

export function adapterFor(key: PlatformKey, mode: "MOCK" | "MANUAL" | "LIVE"): PlatformAdapter {
  if (mode === "MOCK") return simulated(key);
  if (mode === "MANUAL") return manual[key] ?? unavailable(key);
  return live[key] ?? unavailable(key);
}

export function liveAvailability(key: PlatformKey) {
  if (process.env.APP_MODE !== "production") return { available: false, reason: "本地演示环境使用模拟账号。" };
  return adapterFor(key, "LIVE").availability();
}
