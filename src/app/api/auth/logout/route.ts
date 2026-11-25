import { signOut } from "@/server/auth";
import { assertSameOrigin, errorResponse } from "@/server/errors";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await signOut();
    return new Response(null, { status: 303, headers: { location: "/login" } });
  } catch (error) {
    return errorResponse(error);
  }
}
