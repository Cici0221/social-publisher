import { AppError } from "../errors";

export const MAX_ASSET_BYTES = 2 * 1024 ** 3;
export const MAX_IMAGE_BYTES = 64 * 1024 ** 2;
export const UPLOAD_PART_BYTES = 16 * 1024 ** 2;
export const UPLOAD_LIFETIME_MS = 48 * 60 * 60_000;

const formats = {
  jpg: { mime: "image/jpeg", kind: "IMAGE" },
  jpeg: { mime: "image/jpeg", kind: "IMAGE" },
  png: { mime: "image/png", kind: "IMAGE" },
  gif: { mime: "image/gif", kind: "IMAGE" },
  mp4: { mime: "video/mp4", kind: "VIDEO" },
  mov: { mime: "video/quicktime", kind: "VIDEO" },
} as const;

export function checkedUpload(filename: string, mime: string, bytes: number) {
  const clean = filename.trim().normalize("NFC");
  const extension = clean.split(".").at(-1)?.toLowerCase() ?? "";
  const format = Object.hasOwn(formats, extension) ? formats[extension as keyof typeof formats] : undefined;
  if (!clean || clean.length > 250 || /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(clean)) {
    throw new AppError("文件名包含不支持的字符。");
  }
  if (!format || !clean.includes(".")) {
    throw new AppError("请选择 JPG、PNG、GIF、MP4 或 MOV 文件。", 415);
  }
  if (mime && mime !== "application/octet-stream" && mime !== format.mime &&
      !(format.mime === "video/quicktime" && mime === "video/x-quicktime")) {
    throw new AppError("文件格式与扩展名不匹配。", 415);
  }
  const maximum = format.kind === "IMAGE" ? MAX_IMAGE_BYTES : MAX_ASSET_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maximum) {
    throw new AppError(format.kind === "IMAGE" ? "图片需大于零且不超过 64 MiB。" : "视频需大于零且不超过 2 GiB。", 413);
  }
  return { ...format, extension, filename: clean, bytes };
}

export function expectedPartBytes(bytes: number, part: number) {
  const count = Math.ceil(bytes / UPLOAD_PART_BYTES);
  if (!Number.isSafeInteger(part) || part < 1 || part > count) throw new AppError("分片编号无效。", 422);
  return part < count ? UPLOAD_PART_BYTES : bytes - (part - 1) * UPLOAD_PART_BYTES;
}

export type RemotePart = { PartNumber?: number; Size?: number; ETag?: string };

export function verifiedParts(bytes: number, parts: RemotePart[]) {
  const count = Math.ceil(bytes / UPLOAD_PART_BYTES);
  const seen = new Set<number>();
  return parts.flatMap(({ PartNumber, Size, ETag }) => {
    if (!PartNumber || !Number.isInteger(PartNumber) || PartNumber < 1 ||
        PartNumber > count || Size !== expectedPartBytes(bytes, PartNumber) || !ETag ||
        seen.has(PartNumber)) return [];
    seen.add(PartNumber);
    return [{ PartNumber, ETag }];
  }).sort((a, b) => a.PartNumber - b.PartNumber);
}

export function assertCompleteParts(bytes: number, listed: RemotePart[]) {
  const parts = verifiedParts(bytes, listed);
  if (parts.length !== Math.ceil(bytes / UPLOAD_PART_BYTES) || parts.length !== listed.length) {
    throw new AppError("上传尚未完成，或有分片大小不匹配。请重试上传。", 409);
  }
  return parts;
}

export function urlSafeFilename(filename: string) {
  return encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16)}`);
}
