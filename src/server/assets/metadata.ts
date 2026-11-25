import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import sharp from "sharp";
import { AppError } from "../errors";
import { readObject } from "./storage";

const run = promisify(execFile);
const maxImagePixels = 120_000_000;
const invalid = () => new AppError("文件内容与所选类型不符、已损坏，或无法读取媒体信息。", 422);

export type AssetMetadata = { width: number; height: number; duration: number | null; thumbnail: Buffer };

function imageMime(format?: string) {
  switch (format) {
    case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "gif": return "image/gif";
    default: return undefined;
  }
}

export async function imageMetadata(input: string | Buffer, mime: string): Promise<AssetMetadata> {
  try {
    const image = sharp(input, { limitInputPixels: maxImagePixels, failOn: "error" });
    const info = await image.metadata();
    if (imageMime(info.format) !== mime || !info.width || !info.height) throw invalid();
    const rotated = info.orientation && info.orientation >= 5 && info.orientation <= 8;
    const thumbnail = await image.rotate().resize(480, 480, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#e9efe9" }).jpeg({ quality: 80 }).toBuffer();
    return { width: rotated ? info.height : info.width,
      height: rotated ? info.width : info.height, duration: null, thumbnail };
  } catch {
    throw invalid();
  }
}

type VideoInfo = {
  streams?: {
    codec_name?: string; width?: number; height?: number; duration?: string;
    tags?: { rotate?: string }; side_data_list?: { rotation?: number }[];
  }[];
  format?: { duration?: string; tags?: { major_brand?: string } };
};

const localMedia = ["-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0"];
const movieBoxes = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip"]);

export async function videoMetadata(input: string, mime: string, thumbnailPath: string): Promise<AssetMetadata> {
  try {
    const header = await open(input).then(async handle => {
      try {
        const bytes = Buffer.alloc(16);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead < 12) throw invalid();
        return bytes;
      } finally {
        await handle.close();
      }
    });
    if (!movieBoxes.has(header.toString("ascii", 4, 8))) throw invalid();

    const probe = await run("ffprobe", [
      "-v", "error", ...localMedia, "-select_streams", "V:0", "-show_streams", "-show_format",
      "-of", "json", "-i", input,
    ], { timeout: 30_000, maxBuffer: 256 * 1024 });
    const info = JSON.parse(probe.stdout) as VideoInfo;
    const video = info.streams?.[0];
    const duration = Number(info.format?.duration ?? video?.duration);
    const isQuickTime = info.format?.tags?.major_brand?.trim() === "qt" || header.toString("ascii", 8, 12) === "qt  ";
    if ((mime === "video/mp4" && isQuickTime) || (mime === "video/quicktime" && !isQuickTime &&
        header.toString("ascii", 4, 8) === "ftyp")) throw invalid();
    if (!video?.codec_name || !video.width || !video.height || !Number.isFinite(duration) || duration <= 0 ||
        video.width < 1 || video.height < 1 || video.width * video.height > maxImagePixels) throw invalid();
    const rotation = video.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? Number(video.tags?.rotate ?? 0);
    const rotated = Math.abs(rotation) % 180 === 90;
    await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-v", "error", "-threads", "2", ...localMedia, "-i", input,
      "-map", "0:V:0", "-filter_threads", "1", "-vf", "scale=480:480:force_original_aspect_ratio=decrease",
      "-frames:v", "1", "-y", thumbnailPath,
    ], { timeout: 60_000, maxBuffer: 256 * 1024 });
    return { width: rotated ? video.height : video.width, height: rotated ? video.width : video.height,
      duration, thumbnail: await readFile(thumbnailPath) };
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw invalid();
  }
}

export async function inspectAsset(
  asset: { objectKey: string; mime: string; bytes: bigint; kind: "IMAGE" | "VIDEO" },
): Promise<AssetMetadata> {
  const object = await readObject(asset.objectKey);
  if (!object.Body || object.ContentLength !== Number(asset.bytes)) throw invalid();
  if (asset.kind === "IMAGE") return imageMetadata(Buffer.from(await object.Body.transformToByteArray()), asset.mime);

  const directory = await mkdtemp(join(tmpdir(), "publisher-media-"));
  try {
    const input = join(directory, "video");
    const body = object.Body.transformToWebStream() as Parameters<typeof Readable.fromWeb>[0];
    await pipeline(Readable.fromWeb(body), createWriteStream(input, { mode: 0o600, flags: "wx" }),
      { signal: AbortSignal.timeout(6 * 60_000) });
    if ((await stat(input)).size !== Number(asset.bytes)) throw invalid();
    return await videoMetadata(input, asset.mime, join(directory, "thumb.jpg"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
