import { z } from "zod";
import type { Credentials } from "@/platforms/types";
import { decrypt, encrypt } from "./crypto";

const credentialSchema = z.object({
  accountName: z.string().min(1), externalId: z.string().min(1), accessToken: z.string().min(1),
  refreshToken: z.string().optional(), expiresAt: z.iso.datetime({ offset: true }).optional(),
  refreshExpiresAt: z.iso.datetime({ offset: true }).optional(),
  extras: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
});

export function accountCredentials(id: string, sealed: string): Credentials {
  return credentialSchema.parse(JSON.parse(decrypt(sealed, "platform-account:" + id)));
}

export function sealAccount(id: string, credentials: Credentials) {
  return encrypt(JSON.stringify(credentialSchema.parse(credentials)), "platform-account:" + id);
}
