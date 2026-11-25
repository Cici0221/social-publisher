import { signIn } from "@/server/auth";
import { assertSameOrigin, errorResponse } from "@/server/errors";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await signIn(await request.json());
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
