import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateBucketCommand,
  CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand,
  HeadObjectCommand, ListPartsCommand, PutObjectCommand, S3Client, UploadPartCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "../errors";
import { urlSafeFilename, type RemotePart } from "./limits";

let internalClient: S3Client | undefined;
let publicClient: S3Client | undefined;
let providerClient: S3Client | undefined;

function newClient(endpoint: string | undefined) {
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error("S3 凭证配置不完整。");
  return new S3Client({
    endpoint, region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export const storageBucket = () => process.env.S3_BUCKET ?? "publisher-media";
const internal = () => internalClient ??= newClient(process.env.S3_ENDPOINT);
const browser = () => publicClient ??= newClient(process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT);
const provider = () => providerClient ??= newClient(process.env.S3_PROVIDER_ENDPOINT ??
  process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT);

function endpointKey(objectKey: string) {
  return { Bucket: storageBucket(), Key: objectKey };
}

function notFound(error: unknown) {
  return error instanceof Error && ["NoSuchKey", "NotFound", "NoSuchBucket", "NoSuchUpload"].includes(error.name);
}

export async function bootstrapStorage() {
  const client = internal();
  const bucket = { Bucket: storageBucket() };
  // Compose can start the app before the S3 gateway has bound its listener.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await client.send(new HeadBucketCommand(bucket));
      return;
    } catch (error) {
      if (notFound(error)) {
        if (process.env.APP_MODE !== "local") throw error;
        try {
          await client.send(new CreateBucketCommand(bucket));
        } catch (creationError) {
          if (!(creationError instanceof Error && creationError.name === "BucketAlreadyOwnedByYou")) {
            throw creationError;
          }
        }
        return;
      }
      if (!(error instanceof Error && (error.name === "TimeoutError" || error.name === "TypeError" ||
          (error as NodeJS.ErrnoException).code === "ECONNREFUSED")) || attempt === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

export async function beginObject(objectKey: string, mime: string) {
  const result = await internal().send(new CreateMultipartUploadCommand({
    ...endpointKey(objectKey), ContentType: mime, CacheControl: "private, no-store",
  }));
  if (!result.UploadId) throw new Error("对象存储未返回上传会话。");
  return result.UploadId;
}

export async function abortObject(objectKey: string, uploadId: string) {
  try {
    await internal().send(new AbortMultipartUploadCommand({ ...endpointKey(objectKey), UploadId: uploadId }));
  } catch (error) {
    if (!notFound(error)) throw error;
  }
}

export async function listObjectParts(objectKey: string, uploadId: string) {
  const parts: RemotePart[] = [];
  let marker: string | undefined;
  do {
    const result = await internal().send(new ListPartsCommand({
      ...endpointKey(objectKey), UploadId: uploadId, PartNumberMarker: marker,
    }));
    parts.push(...(result.Parts ?? []));
    if (!result.IsTruncated) break;
    const next = result.NextPartNumberMarker;
    if (!next || next === marker) throw new Error("对象存储分片分页异常。");
    marker = next;
  } while (true);
  return parts;
}

export async function signUploadPart(objectKey: string, uploadId: string, part: number, size: number, expiresIn: number) {
  return getSignedUrl(browser(), new UploadPartCommand({
    ...endpointKey(objectKey), UploadId: uploadId, PartNumber: part, ContentLength: size,
  }), { expiresIn, signableHeaders: new Set(["content-length"]) });
}

export async function completeObject(objectKey: string, uploadId: string, parts: { PartNumber: number; ETag: string }[]) {
  await internal().send(new CompleteMultipartUploadCommand({
    ...endpointKey(objectKey), UploadId: uploadId, MultipartUpload: { Parts: parts },
  }));
}

export async function headObjectBytes(objectKey: string) {
  try {
    return (await internal().send(new HeadObjectCommand(endpointKey(objectKey)))).ContentLength;
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
}

export async function readObject(objectKey: string, range?: string): Promise<GetObjectCommandOutput> {
  try {
    return await internal().send(new GetObjectCommand({ ...endpointKey(objectKey), Range: range }));
  } catch (error) {
    if (notFound(error)) throw new AppError("素材文件不存在。", 404);
    throw error;
  }
}

export async function storeThumbnail(objectKey: string, data: Uint8Array) {
  await internal().send(new PutObjectCommand({
    ...endpointKey(objectKey), Body: data, ContentLength: data.byteLength,
    ContentType: "image/jpeg", CacheControl: "private, max-age=300",
  }));
}

export async function deleteObject(objectKey: string) {
  await internal().send(new DeleteObjectCommand(endpointKey(objectKey)));
}

export async function signProviderAsset(objectKey: string, mime: string, filename: string, expiresIn: number) {
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 24 * 60 * 60) {
    throw new Error("素材访问链接的有效期无效。");
  }
  const url = await getSignedUrl(provider(), new GetObjectCommand({
    ...endpointKey(objectKey), ResponseContentType: mime,
    ResponseContentDisposition: `inline; filename*=UTF-8''${urlSafeFilename(filename)}`,
  }), { expiresIn });
  if (process.env.APP_MODE !== "local" && !url.startsWith("https://")) {
    throw new Error("发布平台的素材链接需要 HTTPS 对象存储地址。");
  }
  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}
