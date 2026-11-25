import { jsonInput, writeAssets } from "@/server/assets/http";
import { startUpload } from "@/server/assets/service";

export function POST(request: Request) {
  return writeAssets(request, async actor => Response.json(await startUpload(actor, await jsonInput(request))));
}
