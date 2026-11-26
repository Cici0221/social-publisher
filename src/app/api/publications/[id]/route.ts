import { z } from "zod";
import { requireActor } from "@/server/auth";
import { AppError, assertSameOrigin, errorResponse, readJson } from "@/server/errors";
import { publicationProgress, submitPublication } from "@/server/publications";

type Context = { params: Promise<{ id: string }> };
const submission = z.object({ revision: z.number().int().nonnegative(), skipInvalid: z.boolean().default(false) });

export async function GET(_request: Request, { params }: Context) {
  try {
    const actor = await requireActor("ADMIN", "EDITOR");
    return Response.json(await publicationProgress(actor, (await params).id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor("ADMIN", "EDITOR");
    const data = submission.safeParse(await readJson(request));
    if (!data.success) throw new AppError("发布清单参数无效。", 422);
    const id = await submitPublication(actor, (await params).id, data.data.revision, data.data.skipInvalid);
    return Response.json({ id, href: `/contents/${id}/progress` }, { status: 202 });
  } catch (error) { return errorResponse(error); }
}
