import { readAssets, scheduleAssetWork, writeAssets } from "@/server/assets/http";
import { finishUpload, getUpload } from "@/server/assets/service";

type Context = { params: Promise<{ uploadId: string }> };

export function GET(_request: Request, context: Context) {
  return readAssets(async actor => Response.json(await getUpload(actor, (await context.params).uploadId), {
    headers: { "Cache-Control": "private, no-store" },
  }));
}

export function POST(request: Request, context: Context) {
  return writeAssets(request, async actor => {
    const asset = await finishUpload(actor, (await context.params).uploadId);
    scheduleAssetWork();
    return Response.json({ id: asset.id, status: asset.status }, { status: 202 });
  });
}
