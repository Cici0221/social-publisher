import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

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

export default config;
