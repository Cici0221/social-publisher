import { signIn } from "@/server/auth";
import { assertSameOrigin, errorResponse, readJson } from "@/server/errors";
import { consumeRateLimit, loginClientAddress } from "@/server/rate-limit";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const address = loginClientAddress(request.headers);
    if (address) await consumeRateLimit("login:address:" + address, 60);
    await signIn(await readJson(request), address);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
