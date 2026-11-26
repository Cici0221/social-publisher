import { presetInputSchema } from "@/lib/draft-schema";
import { requireActor } from "@/server/auth";
import { savePreset } from "@/server/drafts";
import { AppError, assertSameOrigin, errorResponse, readJson } from "@/server/errors";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN", "EDITOR");
    const parsed = presetInputSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("填写组合名称并至少选择一个可用账号。", 422);
    return Response.json(await savePreset(actor.id, parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
