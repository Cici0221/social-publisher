import type { NextConfig } from "next";
import { PHASE_PRODUCTION_SERVER } from "next/constants";
import { fileURLToPath } from "node:url";
import { validateRuntimeConfig } from "./src/server/runtime-config";

const root = fileURLToPath(new URL(".", import.meta.url));

const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: root,
  turbopack: { root },
  serverExternalPackages: ["@prisma/adapter-pg", "pg", "bullmq", "sharp"],
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    }];
  },
};

export default function nextConfig(phase: string) {
  if (phase === PHASE_PRODUCTION_SERVER) validateRuntimeConfig();
  return config;
}
