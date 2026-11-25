import type { Media } from "@/platforms/types";
import { mediaForAsset } from "./assets/service";

export async function providerMedia(id: string): Promise<Media> {
  const found = await mediaForAsset(id);
  const meta = found;
  function range(start?: number, end?: number): string | undefined {
    if (start === undefined && end === undefined) return undefined;
    if (start === undefined || end === undefined || !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) || start < 0 || end < start || end >= Number(meta.bytes)) {
      throw new RangeError("Requested media range is invalid");
    }
    return `bytes=${start}-${end}`;
  }
  return {
    id, filename: meta.filename, mime: meta.mime, bytes: Number(meta.bytes),
    kind: meta.kind, width: meta.width, height: meta.height, duration: meta.duration,
    read: async (start, end) => {
      const response = await found.open(range(start, end));
      if (!response.Body) throw new Error("Object storage returned no media bytes");
      return Buffer.from(await response.Body.transformToByteArray());
    },
    stream: async (start, end) => {
      const response = await found.open(range(start, end));
      if (!response.Body) throw new Error("Object storage returned no media stream");
      return response.Body.transformToWebStream();
    },
    url: async (seconds = 900) => (await found.providerGetUrl(seconds)).url,
  };
}
