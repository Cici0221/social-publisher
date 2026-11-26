const exampleKey = "Y29kZXgta2V5LWZvci1sb2NhbC10ZXN0LXByb2plY3Q=";

export class RuntimeConfigError extends Error {}

export function loginProxyHeader(env: Readonly<Record<string, string | undefined>> = process.env) {
  const header = env.LOGIN_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (header && !/^[a-z0-9_-]+$/.test(header)) {
    throw new RuntimeConfigError("LOGIN_CLIENT_IP_HEADER 必须是有效的 HTTP 请求头名称。");
  }
  // Next.js adds these headers itself when missing. Only trust a dedicated proxy header.
  if (header && ["x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto"].includes(header)) {
    throw new RuntimeConfigError("LOGIN_CLIENT_IP_HEADER 必须使用代理专用请求头，例如 X-Real-IP。");
  }
  if (!header && env.APP_MODE === "production") {
    throw new RuntimeConfigError("生产环境必须设置 LOGIN_CLIENT_IP_HEADER，由受信任反向代理写入真实客户端 IP。");
  }
  return header;
}

export function validateRuntimeConfig(env: Readonly<Record<string, string | undefined>> = process.env) {
  const mode = env.APP_MODE ?? "local";
  if (mode !== "local" && mode !== "production") throw new RuntimeConfigError("APP_MODE 必须是 local 或 production。");
  const url = URL.parse(env.APP_URL ?? "http://localhost:3000");
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new RuntimeConfigError("APP_URL 必须使用 HTTP 或 HTTPS。");
  }
  loginProxyHeader(env);
  if (mode === "local") return;

  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new RuntimeConfigError("生产环境的 APP_URL 必须是独立的 HTTPS 站点来源。");
  }
  const key = Buffer.from(env.ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32 || key.equals(Buffer.from(exampleKey, "base64"))) {
    throw new RuntimeConfigError("生产环境需要独立的 32 字节 Base64 加密密钥。");
  }
  if (env.BOOTSTRAP_ADMIN_PASSWORD === "local-publisher-only" ||
      env.BOOTSTRAP_ADMIN_TOTP_SECRET === "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP") {
    throw new RuntimeConfigError("生产环境不能使用演示管理员配置。");
  }
}
