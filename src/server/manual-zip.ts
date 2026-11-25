import { TextReader, ZipWriter } from "@zip.js/zip.js";

export type ManualPackageAsset = {
  filename: string;
  cover: boolean;
  stream: () => Promise<ReadableStream<Uint8Array>>;
};

export function manualPackageFileName(filename: string, index: number, cover: boolean) {
  const clean = filename.normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const extension = clean.match(/\.[A-Za-z0-9]{1,12}$/)?.[0] ?? "";
  const base = extension ? clean.slice(0, -extension.length) : clean;
  const safe = ([...base].slice(0, 100 - extension.length).join("") || "文件") + extension;
  return `${cover ? "封面" : "素材"}/${String(index + 1).padStart(2, "0")}-${safe}`;
}

export function manualPackageStream(text: string, assets: ManualPackageAsset[], requestSignal?: AbortSignal) {
  const source = new TransformStream<Uint8Array, Uint8Array>();
  const response = new TransformStream<Uint8Array, Uint8Array>();
  const abort = new AbortController();
  const signal = requestSignal ? AbortSignal.any([requestSignal, abort.signal]) : abort.signal;
  const zip = new ZipWriter(source.writable, { level: 0, zip64: true, useWebWorkers: false });
  void source.readable.pipeTo(response.writable, { signal }).catch(error => abort.abort(error));
  void (async () => {
    await zip.add("发布文案.txt", new TextReader(text), { signal });
    for (const [index, asset] of assets.entries()) {
      signal.throwIfAborted();
      const file = await asset.stream();
      await zip.add(manualPackageFileName(asset.filename, index, asset.cover), file, { signal });
    }
    await zip.close();
  })().catch(() => abort.abort(new Error("素材包生成中断。")));
  return response.readable;
}
