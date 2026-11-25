import { isPlatform } from "@/lib/platforms";
import { completeAuthorization } from "@/server/accounts";
import { requireActor } from "@/server/auth";

export async function GET(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const { searchParams } = new URL(request.url);
  const result = new URL("/admin/accounts", process.env.APP_URL ?? "http://localhost:3000");
  try {
    const actor = await requireActor("ADMIN");
    const state = searchParams.get("state");
    const code = searchParams.get("code");
    if (!isPlatform(platform) || !state || !code) throw new Error("授权不完整");
    await completeAuthorization(actor, platform, state, code);
    result.searchParams.set("result", "linked");
  } catch { result.searchParams.set("result", "failed"); }
  return new Response(null, { status: 303, headers: { Location: result.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
