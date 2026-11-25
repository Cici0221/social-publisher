import { z } from "zod";
import { requireActor } from "@/server/auth";
import { AppError, errorResponse } from "@/server/errors";
import { manualPackage } from "@/server/manual";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor("ADMIN", "EDITOR");
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new AppError("找不到半自动发布任务。", 404);
    return await manualPackage(actor, id, request.signal);
  } catch (error) {
    return errorResponse(error);
  }
}
