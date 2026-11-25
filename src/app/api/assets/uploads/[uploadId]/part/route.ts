import { z } from "zod";
import { jsonInput, writeAssets } from "@/server/assets/http";
import { uploadPartUrl } from "@/server/assets/service";
import { AppError } from "@/server/errors";

export function POST(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  return writeAssets(request, async actor => {
    const parsed = z.object({ part: z.number().int() }).safeParse(await jsonInput(request));
    if (!parsed.success) throw new AppError("分片编号无效。", 422);
    return Response.json(await uploadPartUrl(actor, (await context.params).uploadId, parsed.data.part), {
      headers: { "Cache-Control": "private, no-store" },
    });
  });
}
