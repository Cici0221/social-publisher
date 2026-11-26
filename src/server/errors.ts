import { errorDetails, logError } from "./logging";

export class AppError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "AppError";
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) return Response.json({ error: error.message }, { status: error.status });
  logError("web.request_failed", { error: errorDetails(error) });
  return Response.json({ error: "操作未完成，请稍后重试。" }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
  try { return await request.json(); }
  catch { throw new AppError("请求格式有误。"); }
}

export function assertSameOrigin(request: Request) {
  const expected = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
  const origin = request.headers.get("origin");
  if (origin !== expected) throw new AppError("请求来源无效。", 403);
}
