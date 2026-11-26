import { notFound } from "next/navigation";
import { z } from "zod";
import { pageActor } from "@/server/auth";
import { draftEditorResources, findDraft } from "@/server/drafts";
import DraftComposer from "./draft-composer";

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await pageActor("ADMIN", "EDITOR");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const draft = await findDraft(actor.id, id);
  if (!draft) notFound();
  const resources = await draftEditorResources(actor.id, draft.draft);
  return <DraftComposer key={id} initial={draft} {...resources} />;
}
