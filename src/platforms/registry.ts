import { platformRules, type PlatformKey } from "@/lib/platforms";
import { bluesky } from "./providers/bluesky";
import { ProviderError, type PlatformAdapter, type Credentials } from "./types";

const live: Partial<Record<PlatformKey, PlatformAdapter>> = { bluesky };

function simulated(key: PlatformKey, manual = false): PlatformAdapter {
  return {
    key,
    availability: () => ({ available: true }),
    refresh: async (credentials: Credentials) => credentials,
    verify: async () => {},
    uploadMedia: async () => ({ kind: "ready" }),
    publish: async context => {
      if (manual) return { kind: "manual" };
      if (process.env.APP_MODE === "local" && process.env.MOCK_FAIL_PLATFORM === key) {
        throw new ProviderError("mock_rejected", "模拟平台拒绝了此任务。", { definite: true });
      }
      return { kind: "success", externalId: "mock-" + context.taskId };
    },
    queryStatus: async context => manual ? { kind: "manual" } :
      { kind: "success", externalId: context.externalId ?? "mock-" + context.taskId },
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
  if (mode === "MANUAL") return simulated(key, true);
  return live[key] ?? unavailable(key);
}

export function liveAvailability(key: PlatformKey) {
  if (process.env.APP_MODE === "local") return { available: false, reason: "本地演示环境使用模拟账号。" };
  return adapterFor(key, "LIVE").availability();
}
