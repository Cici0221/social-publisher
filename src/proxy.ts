import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const nonce = randomBytes(18).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const endpoint = URL.parse(process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? "");
  const bucket = process.env.S3_BUCKET ?? "publisher-media";
  const region = process.env.S3_REGION ?? "us-east-1";
  const pathStyle = process.env.S3_FORCE_PATH_STYLE === "true";
  const connections = ["'self'"];
  if (endpoint && ["http:", "https:"].includes(endpoint.protocol)) {
    connections.push(endpoint.origin);
    if (!pathStyle && /^[a-z0-9.-]+$/.test(bucket)) {
      connections.push(`${endpoint.protocol}//${bucket}.${endpoint.host}`);
    }
  } else if (!endpoint && /^[a-z0-9.-]+$/.test(bucket) && /^[a-z0-9-]+$/.test(region)) {
    connections.push(`https://${pathStyle ? "" : bucket + "."}s3.${region}.amazonaws.com`);
  }
  if (dev) connections.push("ws:", "wss:");
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src ${connections.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon.ico).*)"],
};
