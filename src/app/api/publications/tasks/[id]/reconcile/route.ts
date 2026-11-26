import { requireActor } from "@/server/auth";
import { AppError, assertSameOrigin, errorResponse, readJson } from "@/server/errors";
import { reconciliationSchema, reconcileTask } from "@/server/publications";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN", "EDITOR");
    const parsed = reconciliationSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("请选择核对结果，并填写所需的官方帖子链接或后台凭证。", 422);
    return Response.json(await reconcileTask(actor, (await params).id, parsed.data));
  } catch (error) { return errorResponse(error); }
}
