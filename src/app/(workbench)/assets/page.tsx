import { after } from "next/server";
import { pageActor } from "@/server/auth";
import { canManageAssets, listAssets, wakeAssetMaintenance } from "@/server/assets/service";
import { AssetLibrary } from "./asset-library";

export const metadata = { title: "素材库" };

export default async function AssetsPage() {
  const actor = await pageActor();
  const initial = await listAssets(actor, new URLSearchParams());
  after(wakeAssetMaintenance);
  return <AssetLibrary initial={initial} actorId={actor.id} canManage={canManageAssets(actor)} />;
}
