import { jsonInput, readAssets, scheduleAssetWork, writeAssets } from "@/server/assets/http";
import { assetReferences, editAsset, removeAsset } from "@/server/assets/service";

type Context = { params: Promise<{ assetId: string }> };

export function GET(_request: Request, context: Context) {
  return readAssets(async actor => Response.json({
    references: await assetReferences(actor, (await context.params).assetId),
  }, { headers: { "Cache-Control": "private, no-store" } }));
}

export function PATCH(request: Request, context: Context) {
  return writeAssets(request, async actor => Response.json({
    asset: await editAsset(actor, (await context.params).assetId, await jsonInput(request)),
  }));
}

export function DELETE(request: Request, context: Context) {
  return writeAssets(request, async actor => {
    const result = await removeAsset(actor, (await context.params).assetId);
    if (result.deleted) scheduleAssetWork();
    return Response.json(result, { status: result.deleted ? 200 : 409 });
  });
}
