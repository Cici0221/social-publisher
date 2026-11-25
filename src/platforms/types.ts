import type { Language, PlatformKey } from "@/lib/platforms";

export type PlatformOptions = Record<string, boolean | string | number>;

export type PublishPayload = {
  title: string;
  body: string;
  tags: string[];
  language: Language;
  assetIds: string[];
  coverId: string | null;
  options: PlatformOptions;
};

export type Credentials = {
  externalId: string;
  accountName: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
  extras?: PlatformOptions;
};

export type AuthorizationContext = {
  redirectUri: string;
  state: string;
  verifier: string;
};

export type Media = {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  kind: "IMAGE" | "VIDEO";
  width: number | null;
  height: number | null;
  duration: number | null;
  read: (start?: number, endInclusive?: number) => Promise<Buffer>;
  stream: (start?: number, endInclusive?: number) => Promise<ReadableStream<Uint8Array>>;
  url: (validSeconds?: number) => Promise<string>;
};

export type ProviderState = Record<string, unknown>;

export type AdapterContext = {
  taskId: string;
  createdAt: Date;
  payload: PublishPayload;
  credentials: Credentials;
  media: Media[];
  cover?: Media;
  state: ProviderState;
  externalId?: string;
  checkpoint: (state: ProviderState) => Promise<void>;
  beginSubmission: () => Promise<void>;
};

export type PendingOutcome = { kind: "pending"; externalId?: string; pollInMs?: number };
export type UploadOutcome = { kind: "ready" } | PendingOutcome;
export type SuccessOutcome = { kind: "success"; externalId: string; url?: string };
export type PublishOutcome = SuccessOutcome | PendingOutcome | { kind: "manual" };
export type StatusOutcome = PublishOutcome | { kind: "unknown" } | { kind: "safe-to-resume" };

export interface PlatformAdapter {
  key: PlatformKey;
  availability: () => { available: boolean; reason?: string };
  authorize?: (input: AuthorizationContext) => string;
  exchange?: (input: AuthorizationContext & { code: string }) => Promise<Credentials[]>;
  bindFromEnvironment?: () => Promise<Credentials[]>;
  refresh: (credentials: Credentials) => Promise<Credentials | null>;
  verify: (credentials: Credentials) => Promise<void>;
  validate?: (context: AdapterContext) => Promise<void>;
  uploadMedia: (context: AdapterContext) => Promise<UploadOutcome>;
  publish: (context: AdapterContext) => Promise<PublishOutcome>;
  queryStatus: (context: AdapterContext) => Promise<StatusOutcome>;
}

export type ProviderErrorOptions = {
  retryable?: boolean;
  definite?: boolean;
  reauth?: boolean;
  retryAfterMs?: number;
};

export class ProviderError extends Error {
  constructor(readonly code: string, message: string, readonly options: ProviderErrorOptions = {}) {
    super(message);
    this.name = "ProviderError";
  }
}
