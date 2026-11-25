import { jsonInput, writeAssets } from "@/server/assets/http";
import { createFolder } from "@/server/assets/service";

export function POST(request: Request) {
  return writeAssets(request, async actor => Response.json(await createFolder(actor, await jsonInput(request))));
}
