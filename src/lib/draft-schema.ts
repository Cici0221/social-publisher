import { z } from "zod";
import { platformKeys, type PlatformKey } from "./platforms";

export const draftLanguages = ["ZH", "EN", "JA", "VI"] as const;
export type DraftLanguage = (typeof draftLanguages)[number];

const uniqueIds = z.array(z.uuid()).max(100).refine(ids => new Set(ids).size === ids.length);
export const draftCopySchema = z.strictObject({
  title: z.string().max(500),
  body: z.string().max(100_000),
  tags: z.array(z.string().trim().min(1).max(100)).max(100),
  assetIds: uniqueIds,
  coverId: z.uuid().nullable(),
});

const versionsSchema = z.strictObject({
  ZH: draftCopySchema,
  EN: draftCopySchema.optional(),
  JA: draftCopySchema.optional(),
  VI: draftCopySchema.optional(),
});
const alternativeCopiesSchema = z.partialRecord(z.enum(draftLanguages), draftCopySchema);
const overridesSchema = z.partialRecord(z.enum(platformKeys), alternativeCopiesSchema);

const optionsSchema = z.record(
  z.string().regex(/^[a-z][A-Za-z0-9_]{0,59}$/),
  z.union([z.boolean(), z.string().max(2_000), z.number()]),
).refine(options => Object.keys(options).length <= 40);

export const draftSelectionSchema = z.strictObject({
  accountId: z.uuid(),
  language: z.enum(draftLanguages).optional(),
  runAt: z.iso.datetime({ offset: true }).nullable().optional(),
  options: optionsSchema.optional(),
});

export const draftSchema = z.strictObject({
  versions: versionsSchema,
  overrides: overridesSchema,
  selections: z.array(draftSelectionSchema).refine(rows =>
    new Set(rows.map(row => row.accountId)).size === rows.length),
});

export const draftUpdateSchema = z.strictObject({
  revision: z.number().int().min(0).max(2_147_483_646),
  draft: draftSchema,
});

export const presetInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  accountIds: z.array(z.uuid()).min(1).refine(ids => new Set(ids).size === ids.length),
});

export type DraftCopy = z.infer<typeof draftCopySchema>;
export type DraftSelection = z.infer<typeof draftSelectionSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type DraftUpdate = z.infer<typeof draftUpdateSchema>;

export function emptyDraftCopy(): DraftCopy {
  return { title: "", body: "", tags: [], assetIds: [], coverId: null };
}

export function emptyDraft(): Draft {
  return { versions: { ZH: emptyDraftCopy() }, overrides: {}, selections: [] };
}

export function resolveDraftCopy(
  draft: Pick<Draft, "versions" | "overrides">,
  platform: PlatformKey,
  language: DraftLanguage,
): DraftCopy | undefined {
  return draft.overrides[platform]?.[language] ?? draft.versions[language];
}

export function updateDraftCopy(
  draft: Draft, platform: PlatformKey | null, language: DraftLanguage, patch: Partial<DraftCopy>,
): Draft {
  if (!platform) {
    const copy = { ...(draft.versions[language] ?? emptyDraftCopy()), ...patch };
    return { ...draft, versions: { ...draft.versions, [language]: copy } };
  }

  const copy = { ...(resolveDraftCopy(draft, platform, language) ?? emptyDraftCopy()), ...patch };
  return {
    ...draft,
    overrides: {
      ...draft.overrides,
      [platform]: { ...draft.overrides[platform], [language]: copy },
    },
  };
}

export function restoreDraftCopy(draft: Draft, platform: PlatformKey, language: DraftLanguage): Draft {
  const previous = draft.overrides[platform];
  if (!previous?.[language]) return draft;
  const copies = { ...previous };
  delete copies[language];
  const overrides = { ...draft.overrides };
  if (Object.keys(copies).length) overrides[platform] = copies;
  else delete overrides[platform];
  return { ...draft, overrides };
}

export function draftAssetReferences(draft: Pick<Draft, "versions" | "overrides">) {
  const covers = new Set<string>();
  const assets = new Set<string>();
  const copies = [...Object.values(draft.versions), ...Object.values(draft.overrides).flatMap(value => Object.values(value ?? {}))];
  for (const copy of copies) {
    if (!copy) continue;
    copy.assetIds.forEach(id => assets.add(id));
    if (copy.coverId) {
      covers.add(copy.coverId);
      assets.add(copy.coverId);
    }
  }
  return { assetIds: [...assets].sort(), coverIds: covers };
}
