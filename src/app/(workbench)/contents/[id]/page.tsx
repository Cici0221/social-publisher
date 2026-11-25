import { notFound } from "next/navigation";
import { z } from "zod";
import { pageActor } from "@/server/auth";
import { draftEditorResources, findDraft } from "@/server/drafts";
import DraftComposer from "./draft-composer";

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await pageActor("ADMIN", "EDITOR");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [draft, resources] = await Promise.all([findDraft(actor.id, id), draftEditorResources(actor.id)]);
  if (!draft) notFound();
  return <DraftComposer key={id} initial={draft} {...resources} />;
}
